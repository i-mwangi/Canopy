import { CircleWalletGateway } from '../src/circle/client.ts';
import type { AppConfig } from '../src/config.ts';

/** Provisioning runs before the contracts are deployed, so only the wallet fields are required. */
function provisioningConfig(): AppConfig {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error('CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must both be set');
  }

  return {
    circle: {
      apiKey,
      entitySecret,
      walletSetName: process.env.CIRCLE_WALLET_SET_NAME ?? 'robot-marketplace',
    },
    chain: {
      blockchain: (process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET') as 'ARC' | 'ARC-TESTNET',
      rpcUrl: '',
      usdcTokenId: '',
      robotRegistryAddress: '0x',
      rentalManagerAddress: '0x',
      settlementOperatorWalletId: '',
    },
    marketplace: {
      platformFeeBps: 0,
      authorizationBufferBps: 10_000,
      operatingFloatCeiling: 0n,
      operatingFloatFloor: 0n,
      minimumDeposit: 0n,
      minimumWithdrawal: 0n,
    },
    server: { port: 0 },
  };
}

/**
 * Creates the wallet set and the four platform wallets, then prints the identifiers to put
 * into the environment. Run once per environment, after the entity secret is registered.
 *
 * The settlement operator wallet is the one that signs contract calls, so it needs a USDC
 * balance for gas. The treasury wallet should stay out of the request path entirely.
 */
async function main(): Promise<void> {
  const wallets = new CircleWalletGateway(provisioningConfig());

  const walletSetId = await wallets.createWalletSet();
  console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);

  const roles = ['treasury', 'operating', 'revenue', 'settlement-operator'] as const;
  const provisioned = await wallets.createWallets(walletSetId, roles.length, { accountType: 'SCA' });

  roles.forEach((role, index) => {
    const wallet = provisioned[index];
    if (!wallet) throw new Error(`Circle did not return a wallet for role ${role}`);

    const prefix = role.toUpperCase().replace(/-/g, '_');
    console.log(`${prefix}_WALLET_ID=${wallet.id}`);
    console.log(`${prefix}_WALLET_ADDRESS=${wallet.address}`);
  });

  console.log('\nFund the settlement operator and operating wallets with USDC before going live.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
