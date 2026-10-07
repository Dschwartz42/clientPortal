import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="p-10 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-600">That page does not exist or you do not have access to it.</p>
      <Link to="/dashboard" className="mt-4 inline-block text-sm font-medium underline">
        Back to dashboard
      </Link>
    </div>
  )
}
