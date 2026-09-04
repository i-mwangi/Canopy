import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
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

  const recoveryDir = path.resolve(process.cwd(), 'recovery');
  await mkdir(recoveryDir, { recursive: true });

  // Ask the SDK to write the recovery file itself as well, so a change in the response shape
  // cannot leave this registration without one.
  const response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });

  // Registration has succeeded and Circle will not hand the secret back. Persist it before
  // doing anything else: a failure past this point must not lose it, or the account is left
  // with a registered secret nobody holds.
  await appendFile('.env', `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);
  console.log('Entity secret registered and written to .env');

  // The SDK has already written the file. Only write a copy if the response carried one and
  // the SDK did not, so a single registration does not leave two identical recovery files.
  const recoveryFile = response.data?.recoveryFile;
  const sdkWroteFile = (await readdir(recoveryDir)).some((name) => name.startsWith('recovery_file_'));

  if (recoveryFile && !sdkWroteFile) {
    const recoveryPath = path.join(recoveryDir, `entity-secret-recovery-${Date.now()}.dat`);
    await writeFile(recoveryPath, recoveryFile, { mode: 0o600 });
    console.log(`Recovery file: ${recoveryPath}`);
  } else {
    console.log(`Recovery file written into ${recoveryDir}`);
  }

  console.log('\nMove the recovery file to a secrets manager, and store it apart from the secret.');
  console.log('It is downloadable once. Without it a lost entity secret cannot be reset.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
