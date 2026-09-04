import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { randomBytes } from 'node:crypto';

import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';

/**
 * Generates a 32-byte entity secret, registers it against the Circle account, and writes the
 * recovery file. The recovery file is downloadable once and is the only way to reset a lost
 * entity secret, so it is written outside the repository tree and never committed.
 *
 * Run once per environment:
 *   node --env-file=.env --experimental-transform-types scripts/register-entity-secret.ts
 */
async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error('CIRCLE_API_KEY must be set before registering an entity secret');

  if (process.env.CIRCLE_ENTITY_SECRET) {
    throw new Error(
      'CIRCLE_ENTITY_SECRET is already set. Registering a second secret invalidates the first; ' +
        'rotate through the Circle console instead.',
    );
  }

  // The SDK helper prints a secret rather than returning one, so generate the 32 bytes here.
  const entitySecret = randomBytes(32).toString('hex');

  const response = await registerEntitySecretCiphertext({ apiKey, entitySecret });
  const recoveryFile = response.data?.recoveryFile;
  if (!recoveryFile) throw new Error('Circle did not return a recovery file');

  const recoveryDir = path.resolve(process.cwd(), 'recovery');
  await mkdir(recoveryDir, { recursive: true });

  const recoveryPath = path.join(recoveryDir, `entity-secret-recovery-${Date.now()}.dat`);
  await writeFile(recoveryPath, recoveryFile, { mode: 0o600 });

  await appendFile('.env', `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

  console.log('Entity secret registered.');
  console.log(`Recovery file: ${recoveryPath}`);
  console.log('Move the recovery file to a secrets manager and store it apart from the secret itself.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
