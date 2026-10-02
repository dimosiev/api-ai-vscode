import type { Pricing, Usage } from "./types";

/** Running totals for a task or a whole chat. */
export class UsageTotals {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  /** Size of the most recent request, i.e. how full the context is. */
  lastContext = 0;
  private requests = 0;
  private reported = 0;
  private reportedCount = 0;
  private reportedCurrency?: Pricing["currency"];

  add(u: Usage): void {
    this.requests++;
    if (u.cost && (!this.reportedCurrency || this.reportedCurrency === u.cost.currency)) {
      this.reported += u.cost.amount;
      this.reportedCount++;
      this.reportedCurrency = u.cost.currency;
    }
    this.input += u.inputTokens;
    this.output += u.outputTokens;
    this.cacheRead += u.cacheReadTokens ?? 0;
    this.cacheWrite += u.cacheWriteTokens ?? 0;
    this.lastContext = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  }

  get totalInput(): number {
    return this.input + this.cacheRead + this.cacheWrite;
  }

  /** Exact cost when the service reported it for every request; otherwise an estimate from the price list. */
  cost(p: Pricing | undefined): { amount: number; currency: Pricing["currency"] } | undefined {
    if (this.requests > 0 && this.reportedCount === this.requests && this.reportedCurrency) {
      return { amount: this.reported, currency: this.reportedCurrency };
    }
    if (!p) return undefined;
    const amount =
      (this.input * p.input + this.cacheWrite * p.input * 1.25 + this.cacheRead * p.input * 0.1 + this.output * p.output) / 1e6;
    return { amount, currency: p.currency };
  }
}

export function formatCost(cost: { amount: number; currency: Pricing["currency"] } | undefined): string {
  if (!cost) return "";
  const { amount, currency } = cost;
  if (currency === "RUB") return `${amount < 1 ? amount.toFixed(2) : amount.toFixed(1)} ₽`;
  return `$${amount < 0.1 ? amount.toFixed(3) : amount.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} тыс.`;
  return `${(n / 1_000_000).toFixed(1)} млн`;
}
