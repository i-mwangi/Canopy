import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

/**
 * Arc uses USDC as its native gas token, so the deployer account needs a USDC balance
 * rather than ETH. Everything else behaves like any other EVM chain.
 */
const config: HardhatUserConfig = {
    plugins: [hardhatToolboxViem],
    paths: {
        sources: './src',
        tests: { solidity: './test' },
    },
    solidity: {
        version: '0.8.24',
        settings: {
            optimizer: { enabled: true, runs: 200 },
        },
    },
    networks: {
        hardhatOp: {
            type: 'edr-simulated',
            chainType: 'op',
        },
        arcTestnet: {
            type: 'http',
            url: process.env.ARC_RPC_URL ?? 'http://localhost:8545',
            accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
        },
    },
};

export default config;
