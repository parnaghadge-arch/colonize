import { useMemo, useState, type FormEvent } from 'react';
import type { StructureSetupPayload } from '@colonize/shared';
import { api, ApiError } from '../lib/api.ts';
import { useList, useResource } from '../lib/useResource.ts';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Modal,
  Pagination,
  Pill,
  Select,
  StatusPill,
  useToast,
  type Column,
} from '../components/ui.tsx';
import { StructureSetupForm } from '../components/StructureSetupForm.tsx';
import { number } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { StructureTreeNode, Unit } from '../lib/types.ts';

const UNIT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'FLAT', label: 'Apartment' },
  { value: 'HOUSE', label: 'House' },
  { value: 'PLOT', label: 'Vacant plot' },
  { value: 'TOWER', label: 'Tower' },
  { value: 'VILLA', label: 'Villa' },
  { value: 'BUNGALOW', label: 'Bungalow' },
  { value: 'PENTHOUSE', label: 'Penthouse' },
  { value: 'STUDIO', label: 'Studio' },
  { value: 'SHOP', label: 'Shop' },
  { value: 'OFFICE', label: 'Office' },
  { value: 'GARAGE', label: 'Garage' },
  { value: 'BUILDING', label: 'Building' },
];

function unitTypeLabel(type: string): string {
  return UNIT_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type.split('_').join(' ');
}

interface TreeResponse {
  items: StructureTreeNode[];
}

/**
 * Society structure (§39): buildings → wings → floors → units.
 *
 * The tree comes from one endpoint so the hierarchy is always consistent, while the unit list is
 * paged separately — a society can have tens of thousands of units and the tree only carries
 * counts, never the units themselves.
 */
export function StructurePage() {
  const { can } = useSession();
  const toast = useToast();

  const tree = useResource<TreeResponse>('/structure/tree');
  const society = useResource<{ society?: { layout?: string | null } }>('/society');
  const layout = society.data?.society?.layout ?? null;
  const [buildingId, setBuildingId] = useState<string>('');
  const [wingId, setWingId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 25;

  const units = useList<Unit>(
    '/units',
    { page, limit, buildingId: buildingId || undefined, wingId: wingId || undefined, search: search || undefined },
    [page, buildingId, wingId, search],
  );

  const [dialog, setDialog] = useState<null | 'building' | 'wing' | 'unit' | 'generate'>(null);
  const [error, setError] = useState<unknown>(null);
  const [setupError, setSetupError] = useState<unknown>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<null | { kind: 'building' | 'wing' | 'unit'; data: Record<string, unknown> }>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function reloadStructure() {
    tree.reload();
    units.reload();
  }

  async function remove(kind: 'building' | 'wing' | 'unit', data: Record<string, unknown>, what: string) {
    setDeleting(String(data._id));
    try {
      await api.del(`/${kind}s/${String(data._id)}`);
      toast.success(`${what} removed`);
      if (kind === 'building' && buildingId === String(data._id)) setBuildingId('');
      reloadStructure();
    } catch (err) {
      toast.error(err);
    } finally {
      setDeleting(null);
    }
  }

  const buildings = tree.data?.items ?? [];
  const wings = useMemo(() => {
    const building = buildings.find((b) => b._id === buildingId);
    return (building?.wings ?? []) as StructureTreeNode[];
  }, [buildings, buildingId]);

  const totals = useMemo(() => {
    const totalUnits = buildings.reduce((sum, b) => sum + Number(b.unitCount ?? 0), 0);
    const totalWings = buildings.reduce((sum, b) => sum + ((b.wings?.length as number) ?? 0), 0);
    const totalFloors = buildings.reduce(
      (sum, b) => sum + ((b.wings ?? []) as StructureTreeNode[]).reduce((s, w) => s + ((w.floors?.length as number) ?? 0), 0),
      0,
    );
    return { buildings: buildings.length, wings: totalWings, floors: totalFloors, units: totalUnits };
  }, [buildings]);

  async function addUnits(payload: StructureSetupPayload) {
    setSetupBusy(true);
    setSetupError(null);
    try {
      const result = await api.post<{ summary?: string }>('/structure/setup', payload);
      toast.success(result.summary ?? 'Units added');
      tree.reload();
      units.reload();
    } catch (err) {
      setSetupError(err);
      throw err;
    } finally {
      setSetupBusy(false);
    }
  }

  function afterMutation(message: string) {
    toast.success(message);
    setDialog(null);
    setError(null);
    tree.reload();
    units.reload();
  }

  if (tree.loading && buildings.length === 0) return <Loading label="Loading the society structure…" />;

  const unitColumns: Array<Column<Unit>> = [
    { key: 'label', header: 'Unit', render: (u) => <b>{u.label || u.unitNumber}</b> },
    { key: 'building', header: 'Building', render: (u) => u.building?.name ?? '—' },
    { key: 'wing', header: 'Wing', render: (u) => u.wing?.name ?? '—' },
    { key: 'floor', header: 'Floor', align: 'right', render: (u) => (u.floorNumber < 0 ? '—' : number(u.floorNumber)) },
    { key: 'type', header: 'Type', render: (u) => <Pill>{unitTypeLabel(u.type)}</Pill> },
    { key: 'status', header: 'Status', render: (u) => <StatusPill status={u.status} /> },
    {
      key: 'occupancy',
      header: 'Occupancy',
      render: (u) => <span className="small muted">{u.occupancyType?.split('_').join(' ') ?? '—'}</span>,
    },
    {
      key: 'people',
      header: 'People',
      align: 'right',
      render: (u) => (
        <span className="small muted">
          {number(u.ownerCount ?? 0)} / {number(u.tenantCount ?? 0)} / {number(u.familyCount ?? 0)}
        </span>
      ),
    },
    { key: 'due', header: 'Outstanding', align: 'right', render: (u) => number(u.outstandingAmount ?? 0) },
  ];
  if (can('unit:update') || can('unit:delete')) {
    unitColumns.push({
      key: 'actions',
      header: '',
      align: 'right',
      render: (u) => (
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {can('unit:update') ? (
            <Button size="sm" variant="ghost" onClick={() => setEditTarget({ kind: 'unit', data: u as unknown as Record<string, unknown> })}>
              Edit
            </Button>
          ) : null}
          {can('unit:delete') ? (
            <Button
              size="sm"
              variant="danger"
              busy={deleting === u._id}
              onClick={() => {
                if (window.confirm(`Delete unit ${u.label || u.unitNumber}? Residents, bills and bookings linked to it stop resolving to a unit.`)) {
                  void remove('unit', u as unknown as Record<string, unknown>, `Unit ${u.label || u.unitNumber}`);
                }
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="stack">
      {tree.error ? <ErrorAlert error={tree.error} /> : null}

      {can('unit:create') || can('building:create') ? (
        <Card
          title={buildings.length === 0 ? 'Add units' : 'Add more units'}
          subtitle={
            layout === 'PLOT'
              ? 'How many plots, then vacant plot, house, or tower on each'
              : layout === 'MIXED'
                ? 'Towers and their apartments, then plots. Use 0 to skip a side'
                : layout === 'BUILDING'
                  ? 'How many towers, and how many apartments each tower has'
                  : 'Layout was not set at onboarding, so the tower questions are shown'
          }
        >
          {society.loading && !layout ? (
            <Loading label="Checking how this society is laid out…" />
          ) : (
            <>
              {society.error ? <ErrorAlert error={society.error} /> : null}
              <StructureSetupForm key={layout ?? 'unset'} layout={layout} busy={setupBusy} error={setupError} onSubmit={addUnits} />
            </>
          )}
        </Card>
      ) : null}

      <div className="tiles">
        <div className="tile tile--brand">
          <div className="tile__label">Buildings</div>
          <div className="tile__value">{number(totals.buildings)}</div>
        </div>
        <div className="tile">
          <div className="tile__label">Wings</div>
          <div className="tile__value">{number(totals.wings)}</div>
        </div>
        <div className="tile">
          <div className="tile__label">Floors</div>
          <div className="tile__value">{number(totals.floors)}</div>
        </div>
        <div className="tile tile--success">
          <div className="tile__label">Units</div>
          <div className="tile__value">{number(totals.units)}</div>
        </div>
      </div>

      <Card
        title="Buildings and wings"
        subtitle="The hierarchy every unit hangs off"
        actions={
          can('building:create') ? (
            <div className="row">
              <Button size="sm" type="button" onClick={() => setDialog('building')}>
                Add one building
              </Button>
              {buildingId ? (
                <Button size="sm" variant="primary" onClick={() => setDialog('wing')}>
                  Add wing
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {buildings.length === 0 ? (
          <EmptyState
            title="No buildings yet"
            hint="Use Add units above — it only asks what this society's layout needs. Add one building is for something custom."
          />
        ) : (
          <div className="grid grid--2">
            {buildings.map((building) => (
              <BuildingCard
                key={building._id}
                building={building}
                selected={buildingId === building._id}
                deleting={deleting === String(building._id)}
                canEdit={can('building:update')}
                canDelete={can('building:delete')}
                canEditWing={can('wing:update')}
                canDeleteWing={can('wing:delete')}
                onSelect={() => {
                  setBuildingId(building._id);
                  setWingId('');
                  setPage(1);
                }}
                onEdit={() => setEditTarget({ kind: 'building', data: building as unknown as Record<string, unknown> })}
                onDelete={() => {
                  if (window.confirm(`Delete building ${String(building.name)}? Its wings, floors and units stop resolving to it (the records are kept for the audit trail).`)) {
                    void remove('building', building as unknown as Record<string, unknown>, `Building ${String(building.name)}`);
                  }
                }}
                onEditWing={(wing) => setEditTarget({ kind: 'wing', data: { ...((wing as unknown as Record<string, unknown>)), buildingId: building._id } })}
                onDeleteWing={(wing) => {
                  if (window.confirm(`Delete wing ${String(wing.name)}? Units in this wing become wing-less.`)) {
                    void remove('wing', { ...(wing as unknown as Record<string, unknown>), buildingId: building._id }, `Wing ${String(wing.name)}`);
                  }
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Units"
        subtitle={buildingId ? 'Filtered to the selected building' : 'Across the whole society'}
        actions={
          can('unit:create') ? (
            <div className="row">
              <Button size="sm" onClick={() => setDialog('generate')} disabled={!buildingId}>
                Bulk generate
              </Button>
              <Button size="sm" variant="primary" onClick={() => setDialog('unit')} disabled={!buildingId}>
                Add unit
              </Button>
            </div>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Select
              value={buildingId}
              onChange={(e) => {
                setBuildingId(e.target.value);
                setWingId('');
                setPage(1);
              }}
            >
              <option value="">All buildings</option>
              {buildings.map((b) => (
                <option key={b._id} value={b._id}>
                  {String(b.name)}
                </option>
              ))}
            </Select>
            <Select
              value={wingId}
              onChange={(e) => {
                setWingId(e.target.value);
                setPage(1);
              }}
              disabled={!buildingId}
            >
              <option value="">All wings</option>
              {wings.map((w) => (
                <option key={w._id} value={w._id}>
                  {String(w.name)}
                </option>
              ))}
            </Select>
            <Input
              placeholder="Search unit number or label"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <div className="toolbar__spacer" />
            {(buildingId || wingId || search) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBuildingId('');
                  setWingId('');
                  setSearch('');
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {units.error ? (
          <div className="card__body">
            <ErrorAlert error={units.error} />
          </div>
        ) : units.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={units.page.items}
            empty={
              <EmptyState
                title="No units match"
                hint={buildingId ? 'Try another building or wing.' : 'Add a unit to get started.'}
              />
            }
            columns={unitColumns}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={units.page.total} onPage={setPage} />
        </div>
      </Card>

      {dialog === 'building' ? (
        <BuildingForm
          onClose={() => setDialog(null)}
          onDone={() => afterMutation('Building added')}
          error={error}
          setError={setError}
        />
      ) : null}

      {dialog === 'wing' && buildingId ? (
        <WingForm
          buildingId={buildingId}
          onClose={() => setDialog(null)}
          onDone={() => afterMutation('Wing added')}
          error={error}
          setError={setError}
        />
      ) : null}

      {dialog === 'unit' && buildingId ? (
        <UnitForm
          buildingId={buildingId}
          wings={wings}
          onClose={() => setDialog(null)}
          onDone={() => afterMutation('Unit added')}
          error={error}
          setError={setError}
        />
      ) : null}

      {dialog === 'generate' && buildingId ? (
        <GenerateUnitsForm
          buildingId={buildingId}
          wings={wings}
          onClose={() => setDialog(null)}
          onDone={(count) => afterMutation(`${number(count)} units generated`)}
          error={error}
          setError={setError}
        />
      ) : null}

      {editTarget?.kind === 'building' ? (
        <EditBuildingForm
          data={editTarget.data}
          onClose={() => setEditTarget(null)}
          onDone={() => {
            setEditTarget(null);
            afterMutation('Building updated');
          }}
          error={error}
          setError={setError}
        />
      ) : null}

      {editTarget?.kind === 'wing' ? (
        <EditWingForm
          data={editTarget.data}
          onClose={() => setEditTarget(null)}
          onDone={() => {
            setEditTarget(null);
            afterMutation('Wing updated');
          }}
          error={error}
          setError={setError}
        />
      ) : null}

      {editTarget?.kind === 'unit' ? (
        <EditUnitForm
          data={editTarget.data}
          onClose={() => setEditTarget(null)}
          onDone={() => {
            setEditTarget(null);
            afterMutation('Unit updated');
          }}
          error={error}
          setError={setError}
        />
      ) : null}
    </div>
  );
}

function BuildingCard({
  building,
  selected,
  deleting,
  canEdit,
  canDelete,
  canEditWing,
  canDeleteWing,
  onSelect,
  onEdit,
  onDelete,
  onEditWing,
  onDeleteWing,
}: {
  building: StructureTreeNode;
  selected: boolean;
  deleting: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canEditWing: boolean;
  canDeleteWing: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onEditWing: (wing: StructureTreeNode) => void;
  onDeleteWing: (wing: StructureTreeNode) => void;
}) {
  const wings = (building.wings ?? []) as StructureTreeNode[];
  return (
    <div
      className="card"
      style={selected ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 2px rgba(31,111,235,0.15)' } : undefined}
    >
      <div className="card__head">
        <div style={{ flex: 1 }}>
          <h3>{String(building.name)}</h3>
          <p className="small muted">
            Code {String(building.code ?? '—')} · {number(building.unitCount ?? 0)} units
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {canDelete ? (
            <Button size="sm" variant="danger" busy={deleting} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
          <Button size="sm" variant={selected ? 'primary' : 'default'} onClick={onSelect}>
            {selected ? 'Selected' : 'View units'}
          </Button>
        </div>
      </div>
      <div className="card__body">
        {wings.length === 0 ? (
          <p className="small muted">No wings — units hang directly off this building.</p>
        ) : (
          <div className="row row--wrap" style={{ gap: 6 }}>
            {wings.map((wing) => (
              <span key={wing._id} className="pill" style={selected ? { background: 'var(--brand-soft)' } : undefined}>
                {String(wing.name)} · {number(wing.unitCount ?? 0)}
                {canEditWing || canDeleteWing ? (
                  <span style={{ display: 'inline-flex', gap: 6, marginLeft: 6 }}>
                    {canEditWing ? (
                      <button
                        type="button"
                        onClick={() => onEditWing(wing)}
                        aria-label={`Edit wing ${String(wing.name)}`}
                        title="Edit wing"
                        style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}
                      >
                        ✎
                      </button>
                    ) : null}
                    {canDeleteWing ? (
                      <button
                        type="button"
                        onClick={() => onDeleteWing(wing)}
                        aria-label={`Delete wing ${String(wing.name)}`}
                        title="Delete wing"
                        style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 12, padding: 0, color: 'var(--danger, #c0392b)' }}
                      >
                        ✕
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- forms ---------------------------------- */

interface FormProps {
  onClose: () => void;
  error: unknown;
  setError: (e: unknown) => void;
}

function BuildingForm({ onClose, onDone, error, setError }: FormProps & { onDone: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('TOWER');
  const [totalFloors, setTotalFloors] = useState('10');
  const [unitsPerFloor, setUnitsPerFloor] = useState('4');
  const [hasWings, setHasWings] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/buildings', {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        type,
        totalFloors: Number(totalFloors),
        unitsPerFloor: Number(unitsPerFloor),
        hasWings,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a building"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create building
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tower A — Aman" required autoFocus />
          </Field>
          <Field label="Code" required hint="Short code used on unit labels.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A" maxLength={8} required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {['TOWER', 'BLOCK', 'WING', 'VILLA_ROW', 'BUILDING'].map((t) => (
                <option key={t} value={t}>
                  {t.split('_').join(' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Has wings">
            <Select value={hasWings ? 'yes' : 'no'} onChange={(e) => setHasWings(e.target.value === 'yes')}>
              <option value="yes">Yes — split into wings</option>
              <option value="no">No — floors directly</option>
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Total floors">
            <Input type="number" min={0} value={totalFloors} onChange={(e) => setTotalFloors(e.target.value)} />
          </Field>
          <Field label="Units per floor">
            <Input type="number" min={0} value={unitsPerFloor} onChange={(e) => setUnitsPerFloor(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function WingForm({
  buildingId,
  onClose,
  onDone,
  error,
  setError,
}: FormProps & { buildingId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [totalFloors, setTotalFloors] = useState('10');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/wings', {
        buildingId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        totalFloors: Number(totalFloors),
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a wing"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create wing
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wing A1" required autoFocus />
          </Field>
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A1" maxLength={8} required />
          </Field>
        </div>
        <Field label="Total floors">
          <Input type="number" min={0} value={totalFloors} onChange={(e) => setTotalFloors(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function UnitForm({
  buildingId,
  wings,
  onClose,
  onDone,
  error,
  setError,
}: FormProps & { buildingId: string; wings: StructureTreeNode[]; onDone: () => void }) {
  const [wingId, setWingId] = useState(wings[0]?._id ?? '');
  const [unitNumber, setUnitNumber] = useState('');
  const [floorNumber, setFloorNumber] = useState('1');
  const [type, setType] = useState('FLAT');
  const [carpetAreaSqft, setCarpetArea] = useState('');
  const [bedrooms, setBedrooms] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/units', {
        buildingId,
        wingId: wingId || null,
        unitNumber: unitNumber.trim().toUpperCase(),
        floorNumber: Number(floorNumber),
        type,
        carpetAreaSqft: carpetAreaSqft ? Number(carpetAreaSqft) : null,
        bedrooms: bedrooms ? Number(bedrooms) : null,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a unit"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create unit
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Unit number" required hint="The label is derived from this, the wing and the floor.">
            <Input
              value={unitNumber}
              onChange={(e) => setUnitNumber(e.target.value)}
              placeholder="A-1203"
              required
              autoFocus
            />
          </Field>
          <Field label="Wing">
            <Select value={wingId} onChange={(e) => setWingId(e.target.value)} disabled={wings.length === 0}>
              <option value="">No wing</option>
              {wings.map((w) => (
                <option key={w._id} value={w._id}>
                  {String(w.name)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Floor number">
            <Input type="number" value={floorNumber} onChange={(e) => setFloorNumber(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {UNIT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Carpet area (sq ft)">
            <Input type="number" min={0} value={carpetAreaSqft} onChange={(e) => setCarpetArea(e.target.value)} />
          </Field>
          <Field label="Bedrooms">
            <Input type="number" min={0} value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function GenerateUnitsForm({
  buildingId,
  wings,
  onClose,
  onDone,
  error,
  setError,
}: FormProps & { buildingId: string; wings: StructureTreeNode[]; onDone: (count: number) => void }) {
  const [wingId, setWingId] = useState(wings[0]?._id ?? '');
  const [floors, setFloors] = useState('10');
  const [unitsPerFloor, setUnitsPerFloor] = useState('4');
  const [prefix, setPrefix] = useState('A');
  const [startNumber, setStartNumber] = useState('101');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ created?: number; count?: number; units?: unknown[] }>('/units/generate', {
        buildingId,
        wingId: wingId || null,
        floors: Number(floors),
        unitsPerFloor: Number(unitsPerFloor),
        prefix: prefix.trim().toUpperCase(),
        startNumber: Number(startNumber),
        createFloors: true,
      });
      onDone(Number(result.created ?? result.count ?? result.units?.length ?? 0));
    } catch (err) {
      setError(err instanceof ApiError ? err : err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Bulk-generate units"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Generate
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <p className="small muted mb">
        Creates floors if they are missing, then {number(Number(floors) * Number(unitsPerFloor))} units numbered from{' '}
        <code>
          {prefix || 'A'}
          {startNumber}
        </code>
        .
      </p>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Wing">
            <Select value={wingId} onChange={(e) => setWingId(e.target.value)} disabled={wings.length === 0}>
              <option value="">No wing</option>
              {wings.map((w) => (
                <option key={w._id} value={w._id}>
                  {String(w.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Floors" required>
            <Input type="number" min={1} value={floors} onChange={(e) => setFloors(e.target.value)} required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Units per floor" required>
            <Input
              type="number"
              min={1}
              value={unitsPerFloor}
              onChange={(e) => setUnitsPerFloor(e.target.value)}
              required
            />
          </Field>
          <Field label="Numbering prefix">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="A" maxLength={4} />
          </Field>
        </div>
        <Field label="First unit number">
          <Input type="number" min={1} value={startNumber} onChange={(e) => setStartNumber(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------- edit forms -------------------------------- */

function EditBuildingForm({ data, onClose, onDone, error, setError }: FormProps & { data: Record<string, unknown>; onDone: () => void }) {
  const [name, setName] = useState(String(data.name ?? ''));
  const [code, setCode] = useState(String(data.code ?? ''));
  const [type, setType] = useState(String(data.type ?? 'TOWER'));
  const [totalFloors, setTotalFloors] = useState(String(data.totalFloors ?? ''));
  const [unitsPerFloor, setUnitsPerFloor] = useState(String(data.unitsPerFloor ?? ''));
  const [hasWings, setHasWings] = useState(Boolean(data.hasWings ?? false));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/buildings/${String(data._id)}`, {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        type,
        totalFloors: totalFloors ? Number(totalFloors) : undefined,
        unitsPerFloor: unitsPerFloor ? Number(unitsPerFloor) : undefined,
        hasWings,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit building — ${name || '—'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={name.trim().length === 0}>
            Save changes
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Code" required hint="Short code used on unit labels.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {['TOWER', 'BUILDING', 'BLOCK', 'VILLA_ROW', 'COMPLEX'].map((t) => (
                <option key={t} value={t}>
                  {t.split('_').join(' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Has wings">
            <Select value={hasWings ? 'yes' : 'no'} onChange={(e) => setHasWings(e.target.value === 'yes')}>
              <option value="yes">Yes — split into wings</option>
              <option value="no">No — floors directly</option>
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Total floors" hint="Records only — floors already created are not renumbered.">
            <Input type="number" min={0} value={totalFloors} onChange={(e) => setTotalFloors(e.target.value)} />
          </Field>
          <Field label="Units per floor">
            <Input type="number" min={0} value={unitsPerFloor} onChange={(e) => setUnitsPerFloor(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function EditWingForm({ data, onClose, onDone, error, setError }: FormProps & { data: Record<string, unknown>; onDone: () => void }) {
  const [name, setName] = useState(String(data.name ?? ''));
  const [code, setCode] = useState(String(data.code ?? ''));
  const [totalFloors, setTotalFloors] = useState(String(data.totalFloors ?? ''));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/wings/${String(data._id)}`, {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        totalFloors: totalFloors ? Number(totalFloors) : undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit wing — ${name || '—'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={name.trim().length === 0}>
            Save changes
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} required />
          </Field>
        </div>
        <Field label="Total floors" hint="Records only — floors already created are not renumbered.">
          <Input type="number" min={0} value={totalFloors} onChange={(e) => setTotalFloors(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function EditUnitForm({ data, onClose, onDone, error, setError }: FormProps & { data: Record<string, unknown>; onDone: () => void }) {
  const [unitNumber, setUnitNumber] = useState(String(data.unitNumber ?? ''));
  const [floorNumber, setFloorNumber] = useState(String(data.floorNumber ?? '1'));
  const [type, setType] = useState(String(data.type ?? 'FLAT'));
  const [status, setStatus] = useState(String(data.status ?? 'VACANT'));
  const [carpetAreaSqft, setCarpetArea] = useState(data.carpetAreaSqft != null ? String(data.carpetAreaSqft) : '');
  const [bedrooms, setBedrooms] = useState(data.bedrooms != null ? String(data.bedrooms) : '');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/units/${String(data._id)}`, {
        unitNumber: unitNumber.trim().toUpperCase(),
        floorNumber: Number(floorNumber),
        type,
        status,
        carpetAreaSqft: carpetAreaSqft ? Number(carpetAreaSqft) : null,
        bedrooms: bedrooms ? Number(bedrooms) : null,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit unit — ${String(data.label ?? data.unitNumber ?? '')}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={unitNumber.trim().length === 0}>
            Save changes
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Unit number" required hint="The label is derived from this, the wing and the floor.">
            <Input value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} required autoFocus />
          </Field>
          <Field label="Floor number">
            <Input type="number" value={floorNumber} onChange={(e) => setFloorNumber(e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {UNIT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {['VACANT', 'OCCUPIED', 'LOCKED', 'UNDER_MAINTENANCE'].map((s) => (
                <option key={s} value={s}>
                  {s.split('_').join(' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Carpet area (sq ft)">
            <Input type="number" min={0} value={carpetAreaSqft} onChange={(e) => setCarpetArea(e.target.value)} />
          </Field>
          <Field label="Bedrooms">
            <Input type="number" min={0} value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
