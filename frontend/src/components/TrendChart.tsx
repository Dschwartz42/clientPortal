import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { type Format, formatPeriod, formatValue } from '../lib/format'
import { formatTick } from './chartFormat'

interface Props {
  data: { period: string; value: string | number }[]
  type?: 'line' | 'bar'
  format?: Format
}

export function TrendChart({ data, type = 'line', format = 'number' }: Props) {
  // Money arrives as strings; convert once here, for plotting only.
  const points = data.map((point) => ({
    period: formatPeriod(point.period),
    value: Number(point.value),
  }))
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="period" tick={{ fontSize: 12 }} />
      <YAxis tick={{ fontSize: 12 }} width={48} tickFormatter={(v: number) => formatTick(v, format)} />
      <Tooltip formatter={(v) => formatValue(Number(v), format)} />
    </>
  )

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        {type === 'line' ? (
          <LineChart data={points}>
            {axes}
            <Line type="monotone" dataKey="value" stroke="#0f172a" strokeWidth={2} dot={false} />
          </LineChart>
        ) : (
          <BarChart data={points}>
            {axes}
            <Bar dataKey="value" fill="#475569" />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
