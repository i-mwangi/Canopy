import { network } from 'hardhat';

/**
 * Deploys the registry and the rental manager, then wires them together.
 *
 * The deployer keeps the admin role. The settlement operator role goes to the Circle wallet
 * the server signs with, so no private key for it ever exists locally.
 *
 *   ARC_RPC_URL=… DEPLOYER_PRIVATE_KEY=… SETTLEMENT_OPERATOR_ADDRESS=… npm run deploy
 */
async function main(): Promise<void> {
    const operator = process.env.SETTLEMENT_OPERATOR_ADDRESS as `0x${string}` | undefined;
    if (!operator) throw new Error('SETTLEMENT_OPERATOR_ADDRESS must be set');

    const feeBps = Number(process.env.PLATFORM_FEE_BPS ?? 1500);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 3000) {
        throw new Error('PLATFORM_FEE_BPS must be an integer between 0 and 3000');
    }

    const { viem } = await network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer) throw new Error('No deployer account; is DEPLOYER_PRIVATE_KEY set?');

    const admin = deployer.account.address;
    console.log(`deployer / admin  ${admin}`);
    console.log(`operator          ${operator}`);
    console.log(`platform fee      ${feeBps} bps\n`);

    const registry = await viem.deployContract('RobotRegistry', [admin]);
    console.log(`RobotRegistry     ${registry.address}`);

    const manager = await viem.deployContract('RentalManager', [admin, registry.address, feeBps]);
    console.log(`RentalManager     ${manager.address}\n`);

    // The registry only accepts capacity claims from the manager, and the manager only
    // accepts lifecycle writes from the operator. Both have to be granted after deploy.
    await registry.write.setRentalManager([manager.address]);
    console.log('registry.setRentalManager      done');

    await manager.write.setSettlementOperator([operator]);
    console.log('manager.setSettlementOperator  done\n');

    const wiredManager = await registry.read.rentalManager();
    const wiredOperator = await manager.read.settlementOperator();
    if (wiredManager.toLowerCase() !== manager.address.toLowerCase()) throw new Error('manager not wired');
    if (wiredOperator.toLowerCase() !== operator.toLowerCase()) throw new Error('operator not wired');

    console.log('Add these to server/.env and contracts/.env:');
    console.log(`ROBOT_REGISTRY_ADDRESS=${registry.address}`);
    console.log(`RENTAL_MANAGER_ADDRESS=${manager.address}`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
