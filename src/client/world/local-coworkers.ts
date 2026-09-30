import * as THREE from 'three';
import { Worker } from './character';
import { mesh, toon, textSprite } from './toon';
import { DESKS } from '../../shared/layout';
import type { DeskView, Interactable } from './office';
import type { LocalSession } from '../../shared/local-sessions';

const SEATS_KEY = 'agent-office.local-coworker-seats';
type Visitor = { model: Worker; group: THREE.Group; stool: THREE.Mesh; it: Interactable; desk?: DeskView };

/** Existing sessions, with personal seating remembered per floor. */
export class LocalCoworkers {
  readonly root = new THREE.Group();
  readonly interactables: Interactable[] = [];
  private views = new Map<string, Visitor>();
  private sessions: LocalSession[] = [];
  private floor = '';
  private desks = new Map<string, DeskView>();
  private occupied = new Set<string>();
  private seating: Record<string, Record<string, string>> = {};
  private sign: THREE.Sprite;
  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(SEATS_KEY) ?? '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.seating = saved;
    } catch { /* Storage is optional. */ }
    this.sign = textSprite('LOCAL COWORKERS', { size: 36, color: '#2b2d42', bg: '#fff3bb' });
    this.sign.position.set(5.3, 2.9, 6);
    this.root.add(this.sign);
  }
  private layout(): Record<string, string> {
    const value = this.seating[this.floor];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  choices(key: string): { id: string; label: string }[] {
    if (!this.floor) return [];
    const used = new Set(Object.entries(this.layout()).filter(([k]) => k !== key && this.sessions.some((s) => s.key === k)).map(([, desk]) => desk));
    return DESKS.filter((d) => this.desks.has(d.id) && !this.occupied.has(d.id) && !used.has(d.id)).map((d) => ({ id: d.id, label: d.label }));
  }
  seat(key: string): string | undefined { return this.layout()[key]; }
  move(key: string, deskId: string | null): string | undefined {
    if (!this.floor) return 'Choose an office floor first.';
    if (!this.sessions.some((s) => s.key === key)) return 'That session is no longer available. Refresh Local coworkers.';
    if (deskId && !this.choices(key).some((d) => d.id === deskId)) return 'That desk is taken. Choose another one.';
    const layout = { ...this.layout() };
    if (deskId) layout[key] = deskId;
    else delete layout[key];
    this.seating[this.floor] = layout;
    try { localStorage.setItem(SEATS_KEY, JSON.stringify(this.seating)); } catch { /* Session-only seating. */ }
    this.arrange();
  }
  atDesk(deskId: string): { key: string; title: string } | undefined {
    for (const [key, view] of this.views) if (view.desk?.def.id === deskId) return { key, title: view.it.label ?? 'Local coworker' };
  }
  /** Hired office workers take precedence over monitor-only visitors. */
  context(floor: string | null, desks: Map<string, DeskView>, occupied: Iterable<string>, enabled: boolean) {
    const next = enabled ? floor ?? '' : '';
    const busy = new Set(occupied);
    const changed = next !== this.floor || desks !== this.desks || busy.size !== this.occupied.size || [...busy].some((id) => !this.occupied.has(id));
    this.floor = next; this.desks = desks; this.occupied = busy;
    if (changed) this.arrange();
    for (const view of this.views.values()) if (view.desk) view.desk.vacancy.visible = false;
  }
  sync(sessions: LocalSession[]) { this.sessions = sessions; this.arrange(); }
  private release(view: Visitor) {
    if (view.desk && !this.occupied.has(view.desk.def.id)) view.desk.vacancy.visible = true;
    view.desk = undefined;
    this.root.add(view.group);
  }
  private arrange() {
    const layout = this.layout();
    const assigned = this.sessions.filter((s) => DESKS.some((d) => d.id === layout[s.key]));
    const visible = [...assigned, ...this.sessions.filter((s) => !assigned.includes(s)).slice(0, 8)];
    const keys = new Set(visible.map((s) => s.key));
    for (const [key, view] of this.views) {
      if (keys.has(key)) continue;
      this.release(view); view.group.removeFromParent(); view.stool.geometry.dispose(); view.model.dispose(); this.views.delete(key);
    }
    this.interactables.length = 0;
    let stoolIndex = 0;
    const taken = new Set(this.occupied);
    for (const session of visible) {
      let view = this.views.get(session.key);
      if (!view) {
        const color = session.provider === 'claude' ? '#f29a72' : '#77cbbc';
        const model = new Worker(`${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${session.project.slice(0, 18)}`, color);
        const group = new THREE.Group();
        const stool = mesh(new THREE.CylinderGeometry(0.58, 0.66, 0.34, 24), toon(color), 0, 0.17, 0);
        const it: Interactable = { kind: 'local-session', x: 0, z: 0, radius: 2.5, sessionKey: session.key, label: session.title };
        group.add(stool, model.root); group.userData.interact = it;
        view = { model, group, stool, it }; this.views.set(session.key, view);
      }
      this.release(view);
      const wanted = layout[session.key];
      const desk = this.floor && !taken.has(wanted) ? this.desks.get(wanted) : undefined;
      view.group.rotation.set(0, 0, 0);
      view.it.label = session.title;
      if (desk && DESKS.some((d) => d.id === wanted)) {
        view.desk = desk; taken.add(wanted);
        desk.seatAnchor.add(view.group); view.group.position.set(0, 0, 0);
        view.model.root.position.y = 0; view.stool.visible = false; view.group.visible = true;
        view.it.x = desk.def.x; view.it.z = desk.def.z; view.it.off = false;
        desk.vacancy.visible = false;
      } else {
        const index = stoolIndex++;
        const x = 4.1 + (index % 2) * 2.4, z = 5.8 - Math.floor(index / 2) * 3.2;
        view.group.position.set(x, 0, z); view.model.root.position.y = 0.28; view.stool.visible = true;
        view.group.visible = index < 8; view.it.off = index >= 8;
        view.it.x = x; view.it.z = z;
      }
      view.model.setStatus(session.status === 'working' ? 'working' : 'idle', false);
      this.interactables.push(view.it);
    }
    this.sign.visible = stoolIndex > 0;
    this.root.visible = visible.length > 0;
  }
  update(dt: number, t: number) { for (const view of this.views.values()) if (view.group.visible) view.model.update(dt, t); }
}
