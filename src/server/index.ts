import { createApp } from './app.js';
import { ensureSingleInstance } from './instance.js';
import { getPort } from './paths.js';

function main(): void {
  ensureSingleInstance();
  const app = createApp();
  const port = getPort();
  app.listen(port, () => {
    console.log(`Rever daemon listening on http://localhost:${port}`);
  });
}

main();
