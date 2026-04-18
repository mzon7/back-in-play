/**
 * EdgeValidation — Statistical significance testing panel for the model analysis page.
 * Shows a brief explanation of how edge validity is assessed.
 */

export function EdgeValidation() {
  return (
    <div className="mb-8 rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
      <h2 className="text-lg font-bold mb-1">Edge Validation</h2>
      <p className="text-[11px] text-white/40 mb-3">
        Statistical significance testing — assesses whether model edge is real or noise.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg bg-white/[0.04] border border-white/[0.06] p-3">
          <div className="text-[10px] text-white/40 mb-1 uppercase tracking-wider">Method</div>
          <div className="text-sm text-white/80">Z-test on flat-stake returns</div>
        </div>
        <div className="rounded-lg bg-white/[0.04] border border-white/[0.06] p-3">
          <div className="text-[10px] text-white/40 mb-1 uppercase tracking-wider">Min Sample</div>
          <div className="text-sm text-white/80">≥ 20 bets required</div>
        </div>
        <div className="rounded-lg bg-white/[0.04] border border-white/[0.06] p-3">
          <div className="text-[10px] text-white/40 mb-1 uppercase tracking-wider">Threshold</div>
          <div className="text-sm text-white/80">P(edge) shown per market</div>
        </div>
      </div>
    </div>
  );
}
