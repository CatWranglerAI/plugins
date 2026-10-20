#!/usr/bin/env node
import { runSecretCli } from '../lib/secrets-exec.mjs';

runSecretCli().then(code => { process.exitCode = code; }).catch(error => {
  const code = error instanceof Error && /^SECRET_[A-Z_]+$/.test(error.message)
    ? error.message : 'SECRET_EXEC_FAILED';
  console.error(code);
  process.exitCode = 1;
});
