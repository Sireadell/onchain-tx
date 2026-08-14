import { buildApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;

buildApp().listen(PORT, () => {
  console.log(`telegraph-onchain-tx-lookup-miner listening on :${PORT}`);
});
