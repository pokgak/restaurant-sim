import { formatCents, formatPercent } from "../lib/format";
import type {
  EquipmentAsset,
  RestaurantSnapshot,
  StaffRole,
  StaffRoleState,
} from "../types";

function moneyDelta(cents: number): string {
  return `${cents > 0 ? "+" : ""}${formatCents(cents)}`;
}

function StaffCard({ role, staff }: { role: StaffRole; staff: StaffRoleState }) {
  return (
    <article className="staff-card">
      <div className="operation-card-heading">
        <strong>{role === "chef" ? "Chefs" : "Servers"}</strong>
        <span className={staff.count < staff.targetCount ? "status-warning" : "status-ok"}>
          {staff.count} actual / {staff.targetCount} target
        </span>
      </div>
      <div className="staff-measures">
        <span><b>{staff.absentCount}</b> absent</span>
        <span><b>{formatPercent(staff.averageSkillPercent)}</b> skill</span>
        <span><b>{formatPercent(staff.fatiguePercent)}</b> fatigue</span>
        <span><b>{formatPercent(staff.moralePercent)}</b> morale</span>
      </div>
    </article>
  );
}

function EquipmentCard({ asset }: { asset: EquipmentAsset }) {
  return (
    <article className={`equipment-card equipment-${asset.status}`}>
      <div className="operation-card-heading">
        <strong>{asset.kind === "kitchen" ? "Kitchen" : "Refrigeration"}</strong>
        <span className={`asset-status asset-status-${asset.status}`}>{asset.status}</span>
      </div>
      <div className="condition-row">
        <span>Condition</span>
        <b>{formatPercent(asset.conditionPercent)}</b>
      </div>
      <div
        className="condition-track"
        role="meter"
        aria-label={`${asset.kind} condition ${asset.conditionPercent} percent`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={asset.conditionPercent}
      >
        <span style={{ width: `${Math.min(100, asset.conditionPercent)}%` }} />
      </div>
      <small>
        {asset.downtimeTicks > 0
          ? `${asset.downtimeTicks} ticks of downtime remaining`
          : `${asset.totalBreakdowns} breakdowns · ${asset.totalMaintenance} maintenance visits`}
      </small>
    </article>
  );
}

export function RestaurantDetail({ restaurant }: { restaurant: RestaurantSnapshot }) {
  const report = restaurant.lastTick;
  const netCashAfterDebt = restaurant.cashCents - restaurant.debtCents;
  const costs = report
    ? [
        ["COGS", report.costOfGoodsSoldCents],
        ["Spoilage", report.spoilageCostCents],
        ["Labor", report.wageCostCents],
        ["Marketing", report.marketingCostCents],
        ["Fixed", report.fixedCostCents],
        ["Rent", report.rentCostCents],
        ["Utilities", report.utilityCostCents],
        ["Interest", report.interestCostCents],
        ["Repair", report.repairCostCents],
      ] as const
    : [];
  const inventoryExpense = report
    ? report.costOfGoodsSoldCents + report.spoilageCostCents
    : 0;

  return (
    <section
      className={`panel detail-panel ${restaurant.bankrupt ? "bankrupt-detail" : ""}`}
      aria-labelledby="detail-title"
    >
      <div className="panel-heading detail-heading">
        <div>
          <p className="eyebrow">Selected operation</p>
          <h2 id="detail-title">{restaurant.name}</h2>
        </div>
        <div className="detail-statuses">
          {restaurant.bankrupt && <span className="bankrupt-chip">Bankrupt</span>}
          <span className="reputation-chip">
            Reputation {formatPercent(restaurant.reputationPercent)}
          </span>
        </div>
      </div>

      {restaurant.bankrupt && (
        <div className="bankruptcy-banner" role="status">
          <strong>Operations halted</strong>
          <span>This restaurant is bankrupt; cash is below zero and the latest day reports no service.</span>
        </div>
      )}

      <div className="liquidity-strip" aria-label="Liquidity and solvency">
        <div>
          <span>Cash</span>
          <strong className={restaurant.cashCents < 0 ? "negative-value" : ""}>
            {formatCents(restaurant.cashCents)}
          </strong>
          <small>Available balance</small>
        </div>
        <div>
          <span>Debt</span>
          <strong>{formatCents(restaurant.debtCents)}</strong>
          <small>Outstanding principal</small>
        </div>
        <div>
          <span>Cash after debt</span>
          <strong className={netCashAfterDebt < 0 ? "negative-value" : ""}>
            {formatCents(netCashAfterDebt)}
          </strong>
          <small>Cash minus debt</small>
        </div>
        <div>
          <span>Cumulative op. profit</span>
          <strong>{formatCents(restaurant.cumulativeOperatingProfitCents)}</strong>
          <small>Accounting result</small>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">
          <div>
            <p className="eyebrow">Daily operating inputs</p>
            <h3>Inventory & service</h3>
          </div>
          <span>Menu {formatCents(restaurant.menuPriceCents)} · Marketing {formatCents(restaurant.marketingSpendPerTickCents)}</span>
        </div>
        <div className="operations-grid">
          <div><span>Inventory</span><strong>{restaurant.inventoryUnits} units</strong></div>
          <div><span>Delivered</span><strong>{report?.deliveredUnits ?? 0} units</strong></div>
          <div className={(report?.stockoutUnits ?? 0) > 0 ? "signal-warning" : ""}>
            <span>Lost to stockout</span><strong>{report?.stockoutUnits ?? 0}</strong>
          </div>
          <div className={(report?.wasteUnits ?? 0) > 0 ? "signal-warning" : ""}>
            <span>Spoiled</span><strong>{report?.wasteUnits ?? 0} units</strong>
          </div>
          <div><span>Capacity level</span><strong>{restaurant.capacityLevel}</strong></div>
          <div><span>Quality level</span><strong>{restaurant.qualityLevel}</strong></div>
          <div><span>Coordination load</span><strong>{formatPercent(restaurant.coordinationBurdenPercent)}</strong></div>
          <div><span>Service capacity</span><strong>{report?.serviceCapacityUnits ?? 0} units</strong></div>
        </div>
      </div>

      <div className="detail-columns">
        <div className="detail-section people-section">
          <div className="section-title">
            <div>
              <p className="eyebrow">People</p>
              <h3>Staffing condition</h3>
            </div>
          </div>
          <div className="staff-list">
            <StaffCard role="chef" staff={restaurant.staffing.chef} />
            <StaffCard role="server" staff={restaurant.staffing.server} />
          </div>
        </div>

        <div className="detail-section equipment-section">
          <div className="section-title">
            <div>
              <p className="eyebrow">Physical operation</p>
              <h3>Equipment condition</h3>
            </div>
          </div>
          <div className="equipment-list">
            <EquipmentCard asset={restaurant.equipment.kitchen} />
            <EquipmentCard asset={restaurant.equipment.refrigeration} />
          </div>
        </div>
      </div>

      <div className="detail-section cost-section" aria-label="Latest day cost bridge">
        <div className="section-title">
          <div>
            <p className="eyebrow">Why profit and cash moved</p>
            <h3>Latest day cost bridge</h3>
          </div>
          {report && <span>Tick {report.tick}</span>}
        </div>
        {!report ? (
          <div className="detail-empty">No completed day has been reported.</div>
        ) : (
          <>
            <div className="cost-bridge">
              <div className="cost-revenue">
                <span>Revenue</span>
                <strong>{formatCents(report.revenueCents)}</strong>
              </div>
              {costs.map(([label, value]) => (
                <div className="cost-item" key={label}>
                  <span>{label}</span>
                  <strong>−{formatCents(value)}</strong>
                </div>
              ))}
              <div className="cost-result">
                <span>Operating profit</span>
                <strong>{moneyDelta(report.operatingProfitCents)}</strong>
              </div>
            </div>
            <div className="cash-explanation">
              <div>
                <span>Cash movement</span>
                <strong>{moneyDelta(report.cashFlowCents)}</strong>
              </div>
              <div>
                <span>Prepaid inventory recognized</span>
                <strong>{formatCents(inventoryExpense)}</strong>
              </div>
              <p>
                Cash movement excludes today’s COGS and spoilage because that inventory was paid for when purchased.
                Operating profit recognizes those costs when inventory is sold or spoiled.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
