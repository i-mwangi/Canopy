import { createPublicClient, http, keccak256, toHex, type Address, type PublicClient } from 'viem';

import type { AppConfig } from '../config.ts';
import type { CircleWalletGateway } from '../circle/client.ts';
import type { MeterReading, RateCard } from '../pricing/fare.ts';

export type RobotClass = 0 | 1 | 2;

export type OnChainRobot = {
  id: bigint;
  owner: Address;
  class_: RobotClass;
  status: number;
  rates: RateCard;
  metadataUri: string;
  completedRentals: number;
};

export const ROBOT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getRobot',
    stateMutability: 'view',
    inputs: [{ name: 'robotId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'class_', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          {
            name: 'rates',
            type: 'tuple',
            components: [
              { name: 'baseFare', type: 'uint64' },
              { name: 'perMinute', type: 'uint64' },
              { name: 'perTask', type: 'uint64' },
              { name: 'minimumFare', type: 'uint64' },
            ],
          },
          { name: 'metadataUri', type: 'string' },
          { name: 'completedRentals', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'availableByClass',
    stateMutability: 'view',
    inputs: [{ name: 'class_', type: 'uint8' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nextRobotId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const RENTAL_MANAGER_ABI = [
  {
    type: 'function',
    name: 'nextRentalId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Writes the rental lifecycle to Arc. Every write is submitted from the settlement operator
 * wallet, so the marketplace never asks a renter or an owner to sign anything.
 */
export class RentalChain {
  private readonly publicClient: PublicClient;

  constructor(
    private readonly config: AppConfig,
    private readonly wallets: CircleWalletGateway,
    publicClient?: PublicClient,
  ) {
    this.publicClient =
      publicClient ??
      (createPublicClient({ transport: http(config.chain.rpcUrl) }) as PublicClient);
  }

  async getRobot(robotId: bigint): Promise<OnChainRobot> {
    const result = (await this.publicClient.readContract({
      address: this.config.chain.robotRegistryAddress,
      abi: ROBOT_REGISTRY_ABI,
      functionName: 'getRobot',
      args: [robotId],
    })) as {
      owner: Address;
      class_: number;
      status: number;
      rates: { baseFare: bigint; perMinute: bigint; perTask: bigint; minimumFare: bigint };
      metadataUri: string;
      completedRentals: bigint;
    };

    return {
      id: robotId,
      owner: result.owner,
      class_: result.class_ as RobotClass,
      status: result.status,
      rates: {
        baseFare: result.rates.baseFare,
        perMinute: result.rates.perMinute,
        perTask: result.rates.perTask,
        minimumFare: result.rates.minimumFare,
      },
      metadataUri: result.metadataUri,
      completedRentals: Number(result.completedRentals),
    };
  }

  /** Every robot the registry knows about, in listing order. */
  async listRobots(): Promise<OnChainRobot[]> {
    const total = (await this.publicClient.readContract({
      address: this.config.chain.robotRegistryAddress,
      abi: ROBOT_REGISTRY_ABI,
      functionName: 'nextRobotId',
      args: [],
    })) as bigint;

    const ids = Array.from({ length: Number(total) }, (_, index) => BigInt(index));
    return Promise.all(ids.map((id) => this.getRobot(id)));
  }

  /** Fleet occupancy for a robot class, which is what drives the surge multiplier. */
  async getFleetAvailability(class_: RobotClass): Promise<{ availableRobots: number; totalRobots: number }> {
    const [available, total] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.chain.robotRegistryAddress,
        abi: ROBOT_REGISTRY_ABI,
        functionName: 'availableByClass',
        args: [class_],
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.config.chain.robotRegistryAddress,
        abi: ROBOT_REGISTRY_ABI,
        functionName: 'nextRobotId',
        args: [],
      }) as Promise<bigint>,
    ]);

    return { availableRobots: Number(available), totalRobots: Number(total) };
  }

  async startRental(params: {
    robotId: bigint;
    renter: Address;
    authorizedAmount: bigint;
    surgeBps: number;
    holdRef: string;
  }): Promise<bigint> {
    const rentalId = (await this.publicClient.readContract({
      address: this.config.chain.rentalManagerAddress,
      abi: RENTAL_MANAGER_ABI,
      functionName: 'nextRentalId',
      args: [],
    })) as bigint;

    const receipt = await this.wallets.executeContract({
      walletId: this.config.chain.settlementOperatorWalletId,
      contractAddress: this.config.chain.rentalManagerAddress,
      abiFunctionSignature: 'startRental(uint256,address,uint256,uint32,bytes32)',
      abiParameters: [
        params.robotId.toString(),
        params.renter,
        params.authorizedAmount.toString(),
        params.surgeBps,
        refToBytes32(params.holdRef),
      ],
      idempotencyKey: `start:${params.holdRef}`,
    });

    await this.wallets.waitForTransaction(receipt.transactionId);
    return rentalId;
  }

  async recordMeter(rentalId: bigint, reading: MeterReading): Promise<void> {
    await this.wallets.executeContract({
      walletId: this.config.chain.settlementOperatorWalletId,
      contractAddress: this.config.chain.rentalManagerAddress,
      abiFunctionSignature: 'recordMeter(uint256,uint64,uint64)',
      abiParameters: [
        rentalId.toString(),
        Math.ceil(reading.meteredMinutes).toString(),
        Math.floor(reading.tasksCompleted).toString(),
      ],
      idempotencyKey: `meter:${rentalId}:${Math.ceil(reading.meteredMinutes)}:${reading.tasksCompleted}`,
    });
  }

  async completeRental(rentalId: bigint, reading: MeterReading): Promise<void> {
    const receipt = await this.wallets.executeContract({
      walletId: this.config.chain.settlementOperatorWalletId,
      contractAddress: this.config.chain.rentalManagerAddress,
      abiFunctionSignature: 'completeRental(uint256,uint64,uint64)',
      abiParameters: [
        rentalId.toString(),
        Math.ceil(reading.meteredMinutes).toString(),
        Math.floor(reading.tasksCompleted).toString(),
      ],
      idempotencyKey: `complete:${rentalId}`,
    });

    await this.wallets.waitForTransaction(receipt.transactionId);
  }

  async settleRental(rentalId: bigint, fare: bigint, settlementRef: string): Promise<void> {
    const receipt = await this.wallets.executeContract({
      walletId: this.config.chain.settlementOperatorWalletId,
      contractAddress: this.config.chain.rentalManagerAddress,
      abiFunctionSignature: 'settleRental(uint256,uint256,bytes32)',
      abiParameters: [rentalId.toString(), fare.toString(), refToBytes32(settlementRef)],
      idempotencyKey: `settle:${rentalId}`,
    });

    await this.wallets.waitForTransaction(receipt.transactionId);
  }

  async cancelRental(rentalId: bigint, reason: string): Promise<void> {
    const receipt = await this.wallets.executeContract({
      walletId: this.config.chain.settlementOperatorWalletId,
      contractAddress: this.config.chain.rentalManagerAddress,
      abiFunctionSignature: 'cancelRental(uint256,string)',
      abiParameters: [rentalId.toString(), reason],
      idempotencyKey: `cancel:${rentalId}`,
    });

    await this.wallets.waitForTransaction(receipt.transactionId);
  }
}

/** Off-chain identifiers are hashed so the contract can store a fixed-width reference. */
export function refToBytes32(ref: string): `0x${string}` {
  return keccak256(toHex(ref));
}
