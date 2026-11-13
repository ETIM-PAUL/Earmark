import { startLocalDemo } from "./local-demo.js";

// make demo: the bot and a local chain, with nothing real behind them.
const demo = await startLocalDemo({
  botPort: Number(process.env.BOT_PORT ?? 4003),
  chainPort: Number(process.env.CHAIN_PORT ?? 4010),
  webUrl: process.env.WEB_APP_URL ?? "http://localhost:5173",
});

console.log("\nEarmark demo (local, no keys, no real money)");
console.log(`  bot    ${demo.botUrl}`);
console.log(`  chain  ${demo.chainUrl}  (local stand-in for the receipts contract)`);
const web = process.env.WEB_APP_URL ?? "http://localhost:5173";
console.log(`\nHome page:\n  ${web}/`);
console.log(`\nSender app (sign up with a passkey, set up a family):\n  ${web}/app/#/signup`);
console.log(`\nOr a ready-made family, all three views in one page:\n  ${demo.judge}\n`);
console.log('Then type in the recipient chat: "abeg buy 5k light for my meter", then "yes".');
console.log("Use localhost, not 127.0.0.1: passkeys need it.");
