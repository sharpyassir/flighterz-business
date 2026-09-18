import { useEffect, useMemo, useState } from "react";

/**
 * Employee tree — the org hierarchy that drives approvals. Each person has a
 * manager; a manager can approve for anyone below them (X approves for Y, Y is
 * senior to Z, and so on). Stored locally for now; syncs to the account once the
 * corporate-org API (Phase 2) is live.
 */
type Emp = { id: string; name: string; title: string; email: string; managerId: string | null };
const KEY = "flz_biz_employees";

export function Employees({ primaryContact }: { primaryContact: string }) {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [draft, setDraft] = useState<Emp>({ id: "", name: "", title: "", email: "", managerId: null });

  useEffect(() => {
    try {
      const s = localStorage.getItem(KEY);
      if (s) {
        setEmps(JSON.parse(s));
        return;
      }
    } catch {
      /* ignore */
    }
    // Seed the root with the account's primary contact.
    setEmps([{ id: crypto.randomUUID(), name: primaryContact || "Account owner", title: "Travel administrator", email: "", managerId: null }]);
  }, [primaryContact]);

  const persist = (next: Emp[]) => {
    setEmps(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const add = () => {
    if (!draft.name.trim()) return;
    persist([...emps, { ...draft, id: crypto.randomUUID() }]);
    setDraft({ id: "", name: "", title: "", email: "", managerId: draft.managerId });
  };
  const remove = (id: string) =>
    persist(emps.filter((e) => e.id !== id).map((e) => (e.managerId === id ? { ...e, managerId: null } : e)));

  const roots = useMemo(() => emps.filter((e) => !e.managerId), [emps]);
  const childrenOf = (id: string) => emps.filter((e) => e.managerId === id);

  const Node = ({ e, depth }: { e: Emp; depth: number }) => (
    <div style={{ marginInlineStart: depth * 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          border: "1px solid var(--line)",
          borderRadius: 12,
          marginBottom: 8,
          background: depth === 0 ? "#0d2138" : "#fff",
          color: depth === 0 ? "#fff" : "inherit",
        }}
      >
        <span style={{ fontWeight: 800 }}>{e.name}</span>
        <span className="small" style={{ color: depth === 0 ? "rgba(255,255,255,0.7)" : undefined }}>
          {e.title}
          {e.email ? ` · ${e.email}` : ""}
        </span>
        <button className="pill-btn" style={{ marginInlineStart: "auto" }} onClick={() => remove(e.id)}>
          Remove
        </button>
      </div>
      {childrenOf(e.id).map((c) => (
        <Node key={c.id} e={c} depth={depth + 1} />
      ))}
    </div>
  );

  return (
    <>
      <div className="panel">
        <h2>Add employee</h2>
        <div className="form-grid">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span>Title</span>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Finance manager" />
          </label>
          <label>
            <span>Email</span>
            <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </label>
          <label>
            <span>Reports to</span>
            <select value={draft.managerId ?? ""} onChange={(e) => setDraft({ ...draft, managerId: e.target.value || null })}>
              <option value="">— Top of tree —</option>
              {emps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="pill-btn primary" onClick={add}>
            Add to tree
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Organisation ({emps.length})</h2>
        {roots.map((r) => (
          <Node key={r.id} e={r} depth={0} />
        ))}
        <p className="small" style={{ marginTop: 8 }}>
          A manager can approve travel for anyone below them in the tree. Approval policies (previous tab)
          reference these people as approvers.
        </p>
      </div>
    </>
  );
}
