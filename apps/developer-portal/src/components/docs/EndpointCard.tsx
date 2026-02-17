interface Props {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  params?: { name: string; type: string; required: boolean; desc: string }[];
}

const methodColors: Record<string, string> = {
  GET: "bg-blue-900/50 text-blue-400",
  POST: "bg-emerald-900/50 text-emerald-400",
  PUT: "bg-amber-900/50 text-amber-400",
  DELETE: "bg-red-900/50 text-red-400",
};

export default function EndpointCard({ method, path, description, params }: Props) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-center gap-3 mb-2">
        <span className={`text-xs font-bold px-2 py-1 rounded ${methodColors[method]}`}>
          {method}
        </span>
        <code className="font-mono text-sm text-zinc-300">{path}</code>
      </div>
      <p className="text-sm text-zinc-400 mb-3">{description}</p>
      {params && params.length > 0 && (
        <div className="border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Parameters</p>
          <div className="space-y-1.5">
            {params.map((p) => (
              <div key={p.name} className="flex items-baseline gap-2 text-sm">
                <code className="font-mono text-zinc-300">{p.name}</code>
                <span className="text-xs text-zinc-600">{p.type}</span>
                {p.required && <span className="text-xs text-red-400">required</span>}
                <span className="text-zinc-500 text-xs">{p.desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
