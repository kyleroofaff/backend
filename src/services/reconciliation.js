import { getState } from "../db/store.js";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

const BALANCE_EXPECTED_TYPES = new Set([
  "order_payment",
  "message_fee",
  "post_unlock",
  "order_sale_earning",
  "order_bar_commission",
  "order_platform_commission",
  "custom_request_reversal",
  "custom_request_refund"
]);

function summarizeWalletRows(rows) {
  const byType = {};
  let totalCredits = 0;
  let totalDebits = 0;

  for (const row of rows) {
    const type = String(row.type || "unknown");
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount)) continue;
    if (!byType[type]) {
      byType[type] = { credits: 0, debits: 0, net: 0, expectedBalanced: BALANCE_EXPECTED_TYPES.has(type) };
    }
    if (amount > 0) {
      byType[type].credits += amount;
      totalCredits += amount;
    } else if (amount < 0) {
      const debit = Math.abs(amount);
      byType[type].debits += debit;
      totalDebits += debit;
    }
    byType[type].net += amount;
  }

  const typeRows = Object.entries(byType)
    .map(([type, values]) => ({
      type,
      ...values,
      imbalance: Number((values.credits - values.debits).toFixed(2))
    }))
    .sort((a, b) => a.type.localeCompare(b.type));

  const expectedImbalances = typeRows
    .filter((row) => row.expectedBalanced && Math.abs(row.imbalance) > 0.01)
    .map((row) => ({ type: row.type, imbalance: row.imbalance }));

  return {
    totalCredits: Number(totalCredits.toFixed(2)),
    totalDebits: Number(totalDebits.toFixed(2)),
    globalImbalance: Number((totalCredits - totalDebits).toFixed(2)),
    byType: typeRows,
    expectedTypeImbalances: expectedImbalances
  };
}

async function loadWalletRows() {
  if (hasPostgresConfig()) {
    const result = await pgQuery(
      "SELECT type, amount_thb AS amount FROM wallet_transactions ORDER BY created_at DESC LIMIT 20000"
    );
    return result.rows || [];
  }
  const state = getState();
  return (state.walletTransactions || []).map((entry) => ({
    type: entry.type,
    amount: entry.amount
  }));
}

export async function getWalletReconciliationSummary() {
  const rows = await loadWalletRows();
  const summary = summarizeWalletRows(rows);
  return {
    rowsAnalysed: rows.length,
    source: hasPostgresConfig() ? "postgres" : "in_memory_state",
    ...summary
  };
}
