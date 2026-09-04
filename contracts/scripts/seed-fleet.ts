import { network } from 'hardhat';

/**
 * Lists a starting fleet so the browse page has something in it. The registry deploys empty,
 * and `listRobot` records `msg.sender` as the owner, so whichever account signs here owns the
 * robots and receives their earnings.
 *
 *   ARC_RPC_URL=… DEPLOYER_PRIVATE_KEY=… ROBOT_REGISTRY_ADDRESS=… npm run seed
 */

const PICKING = 0;
const PACKING = 1;
const DELIVERY = 2;

/** Rates are USDC minor units: 1_000_000 is one dollar. */
const FLEET = [
    { class_: PICKING, count: 4, baseFare: 2_000_000n, perMinute: 350_000n, perTask: 600_000n, minimumFare: 3_000_000n },
    { class_: PACKING, count: 3, baseFare: 1_500_000n, perMinute: 250_000n, perTask: 450_000n, minimumFare: 2_500_000n },
    { class_: DELIVERY, count: 3, baseFare: 3_000_000n, perMinute: 500_000n, perTask: 900_000n, minimumFare: 4_000_000n },
] as const;

const CLASS_NAMES = ['Picking', 'Packing', 'Delivery'];

async function main(): Promise<void> {
    const registryAddress = process.env.ROBOT_REGISTRY_ADDRESS as `0x${string}` | undefined;
    if (!registryAddress) throw new Error('ROBOT_REGISTRY_ADDRESS must be set');

    const { viem } = await network.connect();
    const [owner] = await viem.getWalletClients();
    if (!owner) throw new Error('No signing account; is DEPLOYER_PRIVATE_KEY set?');

    const registry = await viem.getContractAt('RobotRegistry', registryAddress);

    const existing = await registry.read.nextRobotId();
    if (existing > 0n) {
        console.log(`Registry already holds ${existing} robot(s). Seeding would add duplicates.`);
        console.log('Delete this check or use a fresh deployment if that is what you want.');
        return;
    }

    console.log(`fleet owner  ${owner.account.address}\n`);

    let listed = 0;
    for (const spec of FLEET) {
        for (let index = 0; index < spec.count; index += 1) {
            const rates = {
                baseFare: spec.baseFare,
                perMinute: spec.perMinute,
                perTask: spec.perTask,
                minimumFare: spec.minimumFare,
            };

            await registry.write.listRobot([
                spec.class_,
                rates,
                `robot://${CLASS_NAMES[spec.class_]!.toLowerCase()}/${index}`,
            ]);

            console.log(`listed robot #${listed}  ${CLASS_NAMES[spec.class_]}`);
            listed += 1;
        }
    }

    const total = await registry.read.nextRobotId();
    console.log(`\n${total} robots listed.`);

    for (const class_ of [PICKING, PACKING, DELIVERY]) {
        const available = await registry.read.availableByClass([class_]);
        console.log(`  ${CLASS_NAMES[class_]}: ${available} available`);
    }

    console.log('\nEvery robot is owned by the signing account. Register it as an owner account');
    console.log('on the server so settlement has somewhere to pay out to.');
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
