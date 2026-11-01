'use client';

import { useCallback, useEffect, useState } from 'react';
import './shisha-admin.css';
// ⚠️ adjust to wherever your browser Supabase client lives
import { createClient } from '@/lib/supabase/client';

type Tab = 'flavours' | 'devices' | 'locations' | 'sessions';
type Table = 'shisha_products' | 'shisha_devices' | 'shisha_locations';

const supabase = createClient();

/**
 * Delete that survives foreign keys + RLS.
 * 1. Try a real DELETE.
 * 2. If sessions reference the row (FK 23503) → archive it (archived_at) so history stays intact.
 * 3. If RLS blocks it, Supabase returns 0 rows with NO error → we surface that instead of failing silently.
 */
async function removeRow(table: Table, id: string): Promise<'deleted' | 'archived'> {
  const del = await supabase.from(table).delete().eq('id', id).select('id');
  if (!del.error) {
    if (del.data && del.data.length > 0) return 'deleted';
    throw new Error('Not permitted. Your user needs the shisha.manage permission.');
  }
  if (del.error.code !== '23503') throw del.error;

  const patch: Record<string, unknown> = { archived_at: new Date().toISOString() };
  if (table === 'shisha_products') patch.is_available = false;
  if (table === 'shisha_locations') patch.is_active = false;

  const arch = await supabase.from(table).update(patch).eq('id', id).select('id');
  if (arch.error) throw arch.error;
  if (!arch.data?.length) throw new Error('Not permitted. Your user needs the shisha.manage permission.');
  return 'archived';
}

export default function ShishaAdmin({ tenantId }: { tenantId: string }) {
  const [tab, setTab] = useState<Tab>('flavours');
  const [products, setProducts] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [revenueToday, setRevenueToday] = useState(0);
  const [loading, setLoading] = useState(true);

  // forms
  const [fName, setFName] = useState('');
  const [fPrice, setFPrice] = useState('250');
  const [dCode, setDCode] = useState('');
  const [dStatus, setDStatus] = useState('available');
  const [lName, setLName] = useState('');
  const [busy, setBusy] = useState(false);

  // modal + toast
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => Promise<void> }>(null);
  const [toast, setToast] = useState<null | { msg: string; type: 'success' | 'error' }>(null);

  const notify = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [p, d, l, s, r] = await Promise.all([
      supabase.from('shisha_products').select('*').eq('tenant_id', tenantId).is('archived_at', null).order('name'),
      supabase.from('shisha_devices').select('*').eq('tenant_id', tenantId).is('archived_at', null).order('device_code'),
      supabase.from('shisha_locations').select('*').eq('tenant_id', tenantId).is('archived_at', null).order('name'),
      supabase
        .from('shisha_sessions')
        .select('*, shisha_devices(device_code), shisha_products(name), shisha_locations(name)')
        .eq('tenant_id', tenantId)
        .neq('status', 'completed')
        .order('start_time', { ascending: false }),
      supabase.from('shisha_sessions').select('total_amount').eq('tenant_id', tenantId).gte('created_at', startOfDay.toISOString()),
    ]);

    const firstErr = [p, d, l, s, r].find((x) => x.error)?.error;
    if (firstErr) notify(firstErr.message, 'error');

    setProducts(p.data ?? []);
    setDevices(d.data ?? []);
    setLocations(l.data ?? []);
    setSessions(s.data ?? []);
    setRevenueToday((r.data ?? []).reduce((sum: number, x: any) => sum + Number(x.total_amount || 0), 0));
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------- add ---------- */
  async function add(table: Table, row: Record<string, unknown>, reset: () => void, label: string) {
    setBusy(true);
    const { error } = await supabase.from(table).insert({ tenant_id: tenantId, ...row });
    setBusy(false);
    if (error) return notify(error.message, 'error');
    reset();
    notify(`${label} added`);
    load();
  }

  /* ---------- delete ---------- */
  function askDelete(table: Table, id: string, name: string, kind: string) {
    setConfirm({
      title: `Delete ${kind}?`,
      message: `"${name}" will be removed. If it has session history it will be archived instead so your records stay intact.`,
      run: async () => {
        try {
          const res = await removeRow(table, id);
          notify(res === 'deleted' ? `${kind} deleted` : `${kind} archived (has session history)`);
          load();
        } catch (e: any) {
          notify(e.message ?? 'Delete failed', 'error');
        }
      },
    });
  }

  async function toggleDeviceStatus(d: any) {
    const next = d.status === 'available' ? 'maintenance' : 'available';
    const { error } = await supabase.from('shisha_devices').update({ status: next }).eq('id', d.id);
    if (error) return notify(error.message, 'error');
    load();
  }

  const tabs: { id: Tab; icon: string; label: string }[] = [
    { id: 'flavours', icon: 'fa-leaf', label: 'Flavours' },
    { id: 'devices', icon: 'fa-fire', label: 'Hookah Devices' },
    { id: 'locations', icon: 'fa-map-marker-alt', label: 'Shisha Stations' },
    { id: 'sessions', icon: 'fa-hourglass-half', label: 'Active Sessions' },
  ];

  const availableDevices = devices.filter((d) => d.status === 'available').length;

  return (
    <div className="shisha-admin">
      {/* Font Awesome (same icons as Rands) */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />

      <div className="app">
        <div className="main-header">
          <h2><i className="fas fa-smoking" /> Shisha Lounge</h2>
          <div className="header-actions">
            <button className="icon-btn" onClick={load} title="Refresh"><i className="fas fa-sync-alt" /></button>
          </div>
        </div>

        <div className="main-content">
          {/* Red-framed stat cards */}
          <div className="stat-grid">
            <Kpi val={products.length} label="Flavours" sub="on the menu" />
            <Kpi val={`${availableDevices}/${devices.length}`} label="Devices" sub="available" />
            <Kpi val={locations.length} label="Stations" sub="active" />
            <Kpi val={sessions.length} label="Live sessions" sub="right now" />
            <Kpi val={`R${revenueToday.toFixed(0)}`} label="Revenue today" sub="all sessions" />
          </div>

          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                <i className={`fas ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>

          {/* FLAVOURS */}
          <div className={`panel ${tab === 'flavours' ? 'active' : ''}`}>
            <div className="section-title"><i className="fas fa-leaf" /> Shisha Flavours</div>
            <div className="add-form">
              <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Flavour name (e.g., Double Apple)" />
              <input type="number" value={fPrice} onChange={(e) => setFPrice(e.target.value)} step={10} placeholder="Price (R)" />
              <button
                disabled={busy || !fName.trim()}
                onClick={() =>
                  add('shisha_products', { name: fName.trim(), price: Number(fPrice) || 0, is_available: true }, () => setFName(''), 'Flavour')
                }
              >
                <i className="fas fa-plus" /> Add Flavour
              </button>
            </div>
            <div className="items-grid">
              {loading ? 'Loading...' : products.length === 0 ? <Empty text="No flavours yet" /> : products.map((p) => (
                <div key={p.id} className="item-card">
                  <div className="item-info">
                    <div className="name">{p.name}</div>
                    <div className="meta">R{Number(p.price).toFixed(0)}</div>
                  </div>
                  <div className="item-actions">
                    <button className="danger" title="Delete" onClick={() => askDelete('shisha_products', p.id, p.name, 'Flavour')}>
                      <i className="fas fa-trash" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* DEVICES */}
          <div className={`panel ${tab === 'devices' ? 'active' : ''}`}>
            <div className="section-title"><i className="fas fa-fire" /> Hookah Devices</div>
            <div className="add-form">
              <input value={dCode} onChange={(e) => setDCode(e.target.value)} placeholder="Device code (e.g., SH-031)" />
              <select value={dStatus} onChange={(e) => setDStatus(e.target.value)}>
                <option value="available">Available</option>
                <option value="maintenance">Maintenance</option>
              </select>
              <button
                disabled={busy || !dCode.trim()}
                onClick={() =>
                  add('shisha_devices', { device_code: dCode.trim(), device_name: dCode.trim(), status: dStatus }, () => setDCode(''), 'Device')
                }
              >
                <i className="fas fa-plus" /> Add Custom Device
              </button>
            </div>
            <div className="items-grid">
              {loading ? 'Loading...' : devices.length === 0 ? <Empty text="No devices yet" /> : devices.map((d) => (
                <div key={d.id} className="item-card">
                  <div className="item-info">
                    <div className="name">{d.device_code}</div>
                    <div className="meta"><span className={`device-status status-${d.status}`}>{d.status}</span></div>
                  </div>
                  <div className="item-actions">
                    <button title="Toggle maintenance" onClick={() => toggleDeviceStatus(d)}><i className="fas fa-wrench" /></button>
                    <button className="danger" title="Delete" onClick={() => askDelete('shisha_devices', d.id, d.device_code, 'Device')}>
                      <i className="fas fa-trash" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* STATIONS */}
          <div className={`panel ${tab === 'locations' ? 'active' : ''}`}>
            <div className="section-title"><i className="fas fa-map-marker-alt" /> Shisha Stations</div>
            <div className="add-form">
              <input value={lName} onChange={(e) => setLName(e.target.value)} placeholder="Shisha Station name (e.g., VIP Terrace)" />
              <button
                disabled={busy || !lName.trim()}
                onClick={() => add('shisha_locations', { name: lName.trim(), is_active: true }, () => setLName(''), 'Station')}
              >
                <i className="fas fa-plus" /> Add Shisha Station
              </button>
            </div>
            <div className="items-grid">
              {loading ? 'Loading...' : locations.length === 0 ? <Empty text="No stations yet" /> : locations.map((l) => (
                <div key={l.id} className="item-card">
                  <div className="item-info">
                    <div className="name">{l.name}</div>
                    <div className="meta">{l.is_active ? 'Active' : 'Inactive'}</div>
                  </div>
                  <div className="item-actions">
                    <button className="danger" title="Delete" onClick={() => askDelete('shisha_locations', l.id, l.name, 'Station')}>
                      <i className="fas fa-trash" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* SESSIONS */}
          <div className={`panel ${tab === 'sessions' ? 'active' : ''}`}>
            <div className="section-title"><i className="fas fa-hourglass-half" /> Active Sessions</div>
            {loading ? (
              <div className="loading-state">Loading active sessions...</div>
            ) : sessions.length === 0 ? (
              <Empty text="No active sessions" />
            ) : (
              <table className="sessions-table">
                <thead>
                  <tr><th>Device</th><th>Flavour</th><th>Station</th><th>Started</th><th>Refills</th><th>Amount</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.shisha_devices?.device_code ?? '—'}</td>
                      <td>{s.shisha_products?.name ?? '—'}</td>
                      <td>{s.shisha_locations?.name ?? '—'}</td>
                      <td>{s.start_time ? new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td>{s.refill_count ?? 0}</td>
                      <td>R{Number(s.total_amount || 0).toFixed(0)}</td>
                      <td><span className={`session-status-badge session-status-${s.paused ? 'paused' : s.status}`}>{s.paused ? 'paused' : s.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Confirm modal */}
        <div className={`custom-modal-overlay ${confirm ? 'active' : ''}`} onClick={() => setConfirm(null)}>
          <div className="custom-modal" onClick={(e) => e.stopPropagation()}>
            <i className="fas fa-exclamation-triangle" />
            <h3>{confirm?.title}</h3>
            <p>{confirm?.message}</p>
            <div className="custom-modal-buttons">
              <button className="custom-modal-btn cancel" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="custom-modal-btn confirm"
                onClick={async () => {
                  const run = confirm?.run;
                  setConfirm(null);
                  await run?.();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>

        <div className={`toast ${toast ? `show ${toast.type}` : ''}`}>{toast?.msg}</div>
      </div>
    </div>
  );
}

function Kpi({ val, label, sub }: { val: string | number; label: string; sub?: string }) {
  return (
    <div className="dash-kpi">
      <div className="val">{val}</div>
      <div className="label">{label}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
      <i className="fas fa-leaf" />
      <div>{text}</div>
    </div>
  );
}
