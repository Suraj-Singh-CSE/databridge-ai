import type { Benchmark } from '@/lib/api-types';

import { adrLabel, metricLabel } from './dashboard-labels';
import { DashboardSection } from './DashboardSection';

/** Offline evaluation results (apps/api benchmarks.ts), each with its ADR and date. */
export function BenchmarksSection({ items }: { items: Benchmark[] }) {
  return (
    <DashboardSection
      id="dashboard-benchmarks"
      title="Benchmark results — measured on synthetic test data"
      description="How well each step did on made-up test data with known answers. These are not results on your data."
    >
      <ul className="grid gap-3 lg:grid-cols-2">
        {items.map((b) => (
          <li key={b.id} className="space-y-2 rounded-lg border px-4 py-3">
            <h3 className="text-sm font-medium">{b.title}</h3>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              {b.metrics.map((m) => (
                <div key={m.name} className="contents">
                  <dt className="text-muted-foreground">{metricLabel(m.name)}</dt>
                  <dd className="text-right tabular-nums">{m.display}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {adrLabel(b.source)} · measured {b.measuredOn} · {b.set}
            </p>
          </li>
        ))}
      </ul>
    </DashboardSection>
  );
}
