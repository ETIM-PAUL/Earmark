import { usdToNaira } from "../format.js";
import type { AppConfig, Overview } from "../types.js";

export function TopUp({ config, overview: o }: { config: AppConfig; overview: Overview }) {
  const monthly = `$${o.budget.monthlyUsd}`;
  const naira = usdToNaira(monthly, o.rateNgnPerUsd);
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Top up</h1>
      </div>
      <p role="status" className="note-box">
        Not available in this build.
      </p>
      <section className="stack">
        <p>{config.topUp.why}</p>
        <p className="fine">
          When it is on, you pick a chain and a token, we show a fresh deposit address, and the
          money arrives in your family account as USDC. No balance is shown here, because there is
          no real account behind it, and we won't invent one.
        </p>
      </section>
      <section className="stack" aria-labelledby="cover-h">
        <h2 id="cover-h">What a top-up will cover</h2>
        <p>
          Your monthly budget is {monthly}
          {naira ? `, about ${naira}` : ""}.
        </p>
      </section>
    </div>
  );
}
