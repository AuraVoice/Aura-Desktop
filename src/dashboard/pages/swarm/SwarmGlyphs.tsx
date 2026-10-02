/** The Swarm tab's own glyph set. Every mark is built from the same three parts
 * (nodes, links, orbits) so the tab reads as one system, and every one has its own
 * motion, driven from dashboard.css (`.sw-g-*`). Nothing here comes from an icon
 * library. Sizes are in CSS px; the art is drawn on a 24-unit grid. */

import type { SVGProps } from "react";

type GlyphProps = { size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, "viewBox">;

function Glyph({ name, size = 18, className = "", children, ...svg }: GlyphProps & { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`sw-g sw-g-${name} ${className}`.trim()}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...svg}
    >
      {children}
    </svg>
  );
}

/** The Swarm mark: three agents orbiting one core. */
export function SwarmMark(p: GlyphProps) {
  return (
    <Glyph name="mark" {...p}>
      <ellipse cx="12" cy="12" rx="9.2" ry="9.2" className="sw-orbit" strokeDasharray="2.2 3.2" strokeWidth={1.2} />
      <circle cx="12" cy="12" r="3" className="sw-core" fill="currentColor" stroke="none" />
      <g className="sw-sats">
        <circle cx="12" cy="2.8" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="20" cy="16.6" r="1.5" fill="currentColor" stroke="none" opacity="0.8" />
        <circle cx="4" cy="16.6" r="1.2" fill="currentColor" stroke="none" opacity="0.6" />
      </g>
    </Glyph>
  );
}

/** New workflow: a node about to split into four. */
export function SpawnGlyph(p: GlyphProps) {
  return (
    <Glyph name="spawn" {...p}>
      <g className="sw-arms">
        <path d="M12 3.5v4.2M12 16.3v4.2M3.5 12h4.2M16.3 12h4.2" />
      </g>
      <circle cx="12" cy="12" r="2.3" className="sw-core" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A shared channel: a lattice with one live crossing. */
export function LatticeGlyph(p: GlyphProps) {
  return (
    <Glyph name="lattice" {...p}>
      <path d="M9.5 4 7.6 20M16.4 4l-1.9 16M4.5 9h15.5M4 15h15.5" strokeWidth={1.6} />
      <circle cx="15.7" cy="9" r="2.3" className="sw-node" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** The activity log: a heartbeat with a pulse running along it. */
export function PulseGlyph(p: GlyphProps) {
  return (
    <Glyph name="pulse" {...p}>
      <path d="M2.5 13h4l2.2-5.5 3.4 10 2.9-7.2 1.8 2.7h4.7" strokeWidth={1.5} opacity="0.45" />
      <path d="M2.5 13h4l2.2-5.5 3.4 10 2.9-7.2 1.8 2.7h4.7" className="sw-trace" pathLength={1} />
    </Glyph>
  );
}

/** Send: a dart with a particle trail. */
export function DartGlyph(p: GlyphProps) {
  return (
    <Glyph name="dart" {...p}>
      <g className="sw-trail" stroke="none" fill="currentColor">
        <circle cx="6.2" cy="17.8" r="1.25" opacity="0.75" />
        <circle cx="3.6" cy="20.4" r="0.9" opacity="0.5" />
        <circle cx="9" cy="19.6" r="0.75" opacity="0.4" />
      </g>
      <path className="sw-head" d="M20.5 3.5 8.6 9.4l3.9 2.1 2.1 3.9 5.9-11.9Z" fill="currentColor" strokeWidth={1.4} />
    </Glyph>
  );
}

/** Attach a file: a page with a folded corner and a node docking onto it. */
export function SheetGlyph(p: GlyphProps) {
  return (
    <Glyph name="sheet" {...p}>
      <path d="M6 3.5h7.6L18 7.9V20.5H6Z" strokeWidth={1.5} />
      <path d="M13.4 3.7v4.4h4.4" strokeWidth={1.3} opacity="0.7" />
      <path d="M9 13h6M9 16.4h4" strokeWidth={1.3} opacity="0.55" />
      <circle cx="18.2" cy="18.4" r="2.1" className="sw-node" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Pin a file to a manager: a node held by a stem. */
export function TackGlyph(p: GlyphProps) {
  return (
    <Glyph name="tack" {...p}>
      <path d="M12 13.2v7.3" strokeWidth={1.6} />
      <circle cx="12" cy="8.6" r="4.4" className="sw-node" fill="currentColor" stroke="none" opacity="0.9" />
    </Glyph>
  );
}

/** Reset: an orbit rewinding into its starting node. */
export function RewindGlyph(p: GlyphProps) {
  return (
    <Glyph name="rewind" {...p}>
      <g className="sw-spin">
        <path d="M5.2 8.4A8 8 0 1 1 4.6 15" />
        <path d="M5.4 3.9v4.6h4.6" strokeWidth={1.5} />
      </g>
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** The team panel: three linked agents. */
export function TeamGlyph(p: GlyphProps) {
  return (
    <Glyph name="team" {...p}>
      <path className="sw-links" d="M12 6.5 5.8 16.8M12 6.5l6.2 10.3M5.8 16.8h12.4" strokeWidth={1.3} pathLength={1} />
      <circle className="sw-n1" cx="12" cy="5.6" r="2.7" fill="currentColor" stroke="none" />
      <circle className="sw-n2" cx="5.4" cy="17.4" r="2.2" fill="currentColor" stroke="none" opacity="0.8" />
      <circle className="sw-n3" cx="18.6" cy="17.4" r="2.2" fill="currentColor" stroke="none" opacity="0.8" />
    </Glyph>
  );
}

/** Close: two links parting around a node. */
export function DismissGlyph(p: GlyphProps) {
  return (
    <Glyph name="dismiss" {...p}>
      <path d="M6 6l4.2 4.2M13.8 13.8 18 18M18 6l-4.2 4.2M10.2 13.8 6 18" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Expand: a link with a node riding its tip. */
export function CaretGlyph(p: GlyphProps) {
  return (
    <Glyph name="caret" {...p}>
      <path d="M9 5.5 15 12l-6 6.5" strokeWidth={1.9} />
      <circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" className="sw-tip" />
    </Glyph>
  );
}

/** Paused: an orbit with its satellite held still. */
export function HoldGlyph(p: GlyphProps) {
  return (
    <Glyph name="hold" {...p}>
      <path d="M17.6 6.4A8 8 0 1 0 19.8 13" strokeDasharray="1.6 2.6" strokeWidth={1.3} />
      <path d="M10 9v6M14 9v6" strokeWidth={2} />
      <circle cx="19.6" cy="9.4" r="1.6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Something needs you: a cell with a signal inside. */
export function SignalGlyph(p: GlyphProps) {
  return (
    <Glyph name="signal" {...p}>
      <path className="sw-cell" d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" strokeWidth={1.5} />
      <path d="M12 8v4.6" strokeWidth={2} />
      <circle cx="12" cy="16" r="1.25" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Model usage: tokens flowing as three bars. */
export function FluxGlyph(p: GlyphProps) {
  return (
    <Glyph name="flux" {...p}>
      <path className="sw-b1" d="M6 18V10" strokeWidth={2.4} />
      <path className="sw-b2" d="M12 18V6" strokeWidth={2.4} />
      <path className="sw-b3" d="M18 18v-5" strokeWidth={2.4} />
      <path d="M3.5 21h17" strokeWidth={1.2} opacity="0.5" />
    </Glyph>
  );
}

/** Crossposted from #group: a hop along a curve. */
export function HopGlyph(p: GlyphProps) {
  return (
    <Glyph name="hop" {...p}>
      <path d="M4 5c0 8 4 12 14 12" className="sw-path" strokeDasharray="2 2.6" />
      <path d="M14.5 13.4 18.2 17l-3.7 3.6" strokeWidth={1.6} />
      <circle cx="4" cy="5" r="1.9" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A swarm event: a four-point spark with a satellite. */
export function SparkGlyph(p: GlyphProps) {
  return (
    <Glyph name="spark" {...p}>
      <path className="sw-star" d="M11 3c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7Z" fill="currentColor" strokeWidth={1} />
      <circle className="sw-sat" cx="19" cy="18.5" r="1.6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** The Supervisor: three nodes crowning an arc. */
export function CrownGlyph(p: GlyphProps) {
  return (
    <Glyph name="crown" {...p}>
      <path d="M4.5 16.5 6.6 9l5.4 4.4L17.4 9l2.1 7.5" strokeWidth={1.6} />
      <path d="M5 20c4.4-1.6 9.6-1.6 14 0" strokeWidth={1.6} />
      <circle className="sw-c1" cx="6.6" cy="7.6" r="1.7" fill="currentColor" stroke="none" />
      <circle className="sw-c2" cx="12" cy="5.2" r="2.1" fill="currentColor" stroke="none" />
      <circle className="sw-c3" cx="17.4" cy="7.6" r="1.7" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A manager was hired: a burst around a new core. */
export function BurstGlyph(p: GlyphProps) {
  return (
    <Glyph name="burst" {...p}>
      <g className="sw-rays" strokeWidth={1.6}>
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
      </g>
      <circle cx="12" cy="12" r="3.4" className="sw-core" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A subagent: a hex cell with a core. */
export function CellGlyph(p: GlyphProps) {
  return (
    <Glyph name="cell" {...p}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" strokeWidth={1.5} />
      <circle cx="12" cy="12" r="2.7" className="sw-core" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** The verifier: a hex cell with a watching eye. */
export function WatchGlyph(p: GlyphProps) {
  return (
    <Glyph name="watch" {...p}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" strokeWidth={1.5} />
      <g className="sw-eye">
        <path d="M7.4 12c2.6-3.6 6.6-3.6 9.2 0-2.6 3.6-6.6 3.6-9.2 0Z" strokeWidth={1.4} />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </g>
    </Glyph>
  );
}

/** web.search: a lens whose glass is a small orbit. */
export function SeekGlyph(p: GlyphProps) {
  return (
    <Glyph name="seek" {...p}>
      <circle cx="10.5" cy="10.5" r="6.2" strokeWidth={1.6} />
      <path d="M15.2 15.2 20.5 20.5" strokeWidth={2} />
      <circle className="sw-sat" cx="10.5" cy="6.3" r="1.5" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** web.read: a page with lines being taken in. */
export function LeafGlyph(p: GlyphProps) {
  return (
    <Glyph name="leaf" {...p}>
      <path d="M6 3.5h8.5l3.5 3.5v13.5H6Z" strokeWidth={1.5} />
      <path className="sw-lines" d="M8.8 11h6.4M8.8 14.2h6.4M8.8 17.4h4" strokeWidth={1.5} pathLength={1} />
      <circle cx="14.5" cy="6.6" r="1.3" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Mail: an envelope whose flap is a link between two nodes. */
export function MailGlyph(p: GlyphProps) {
  return (
    <Glyph name="mail" {...p}>
      <path d="M3.5 6.5h17v11h-17Z" strokeWidth={1.5} />
      <path className="sw-flap" d="M3.8 7 12 13l8.2-6" strokeWidth={1.5} />
      <circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Calendar: a grid with one live day. */
export function DayGlyph(p: GlyphProps) {
  return (
    <Glyph name="day" {...p}>
      <path d="M4 6h16v14H4ZM4 10h16M8.5 3.5V7M15.5 3.5V7" strokeWidth={1.5} />
      <circle className="sw-node" cx="15" cy="15" r="2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Classroom: a stacked course with a due marker. */
export function CourseGlyph(p: GlyphProps) {
  return (
    <Glyph name="course" {...p}>
      <path d="M3.5 9 12 5l8.5 4L12 13Z" strokeWidth={1.5} />
      <path d="M7 11v4.2c2.8 2 7.2 2 10 0V11" strokeWidth={1.5} />
      <circle className="sw-node" cx="20.5" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Code activity: a branch that forks and rejoins. */
export function BranchGlyph(p: GlyphProps) {
  return (
    <Glyph name="branch" {...p}>
      <path d="M7 5v14M7 9c0 4 10 2 10 6v4" strokeWidth={1.5} />
      <circle cx="7" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="7" cy="19" r="1.8" fill="currentColor" stroke="none" />
      <circle className="sw-node" cx="17" cy="19" r="1.8" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Saved posts: a bookmark ribbon holding a node. */
export function KeepGlyph(p: GlyphProps) {
  return (
    <Glyph name="keep" {...p}>
      <path d="M7 3.5h10v17l-5-3.8-5 3.8Z" strokeWidth={1.5} />
      <circle className="sw-node" cx="12" cy="9.5" r="1.8" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Notes: stacked blocks with a cursor node. */
export function BlockGlyph(p: GlyphProps) {
  return (
    <Glyph name="block" {...p}>
      <path d="M4.5 5h15M4.5 10h10M4.5 15h15M4.5 20h7" strokeWidth={1.6} />
      <circle className="sw-node" cx="18.5" cy="10" r="1.6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** A Research hand-off: a node launched onto a wide orbit. */
export function DeepGlyph(p: GlyphProps) {
  return (
    <Glyph name="deep" {...p}>
      <ellipse cx="12" cy="12" rx="9" ry="4.2" strokeWidth={1.3} strokeDasharray="1.8 2.4" className="sw-orbit" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <circle className="sw-sat" cx="21" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Stop: an orbit closing on its core. */
export function HaltGlyph(p: GlyphProps) {
  return (
    <Glyph name="halt" {...p}>
      <circle cx="12" cy="12" r="8.4" strokeWidth={1.4} strokeDasharray="2 2.4" className="sw-orbit" />
      <rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Verified: a hex cell sealed by a check. */
export function SealGlyph(p: GlyphProps) {
  return (
    <Glyph name="seal" {...p}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" strokeWidth={1.5} />
      <path className="sw-check" d="m8.4 12.2 2.5 2.5 4.8-5.2" strokeWidth={1.9} pathLength={1} />
    </Glyph>
  );
}

/** A schedule: a clock face drawn as an orbit with one hand. */
export function CycleGlyph(p: GlyphProps) {
  return (
    <Glyph name="cycle" {...p}>
      <circle cx="12" cy="12" r="8.2" strokeWidth={1.5} />
      <path className="sw-hand" d="M12 12V7.2M12 12l3.2 2" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Starter: climbing toward an offer. */
export function AscentGlyph(p: GlyphProps) {
  return (
    <Glyph name="ascent" {...p}>
      <path className="sw-route" d="M4 19.5 9 14.5l3.6 2.6L19 8.5" pathLength={1} />
      <circle cx="4" cy="19.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="9" cy="14.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="17.1" r="1.5" fill="currentColor" stroke="none" />
      <path className="sw-flag" d="M19 8.5V3.5l3 1.6-3 1.6" fill="currentColor" strokeWidth={1.3} />
    </Glyph>
  );
}

/** Starter: shipping a build, a node orbiting between brackets. */
export function BuildGlyph(p: GlyphProps) {
  return (
    <Glyph name="build" {...p}>
      <path d="M7.5 6.5 2.8 12l4.7 5.5M16.5 6.5l4.7 5.5-4.7 5.5" />
      <g className="sw-orb">
        <circle cx="12" cy="7.6" r="1.8" fill="currentColor" stroke="none" />
      </g>
      <circle cx="12" cy="12" r="4.4" strokeDasharray="1.4 2.2" strokeWidth={1.1} opacity="0.6" />
    </Glyph>
  );
}

/** Starter: a semester, an open book with a spark rising off it. */
export function StudyGlyph(p: GlyphProps) {
  return (
    <Glyph name="study" {...p}>
      <path d="M12 19.5c-2.6-1.8-5.6-2.3-9-1.8V7.4c3.4-.5 6.4 0 9 1.8 2.6-1.8 5.6-2.3 9-1.8v10.3c-3.4-.5-6.4 0-9 1.8Z" strokeWidth={1.5} />
      <path d="M12 9.2v10.3" strokeWidth={1.2} opacity="0.6" />
      <path className="sw-rise" d="M17 1.6c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" fill="currentColor" strokeWidth={0.8} />
    </Glyph>
  );
}

/** You: a bright core inside a turning ring. */
export function YouGlyph(p: GlyphProps) {
  return (
    <Glyph name="you" {...p}>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 2.4" strokeWidth={1.3} className="sw-ring" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" className="sw-core" />
    </Glyph>
  );
}

function hash(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A manager's own mark, generated from its id: 3 to 6 nodes on a ring, joined as a
 * polygon or a star, around a core. Two managers practically never share one, and the
 * same manager always gets the same one. */
export function Sigil({ id, size = 22, className = "", x, y }: { id: string; size?: number; className?: string; x?: number; y?: number }) {
  const nodes = 3 + (hash(id, 1) % 4);
  const twist = (hash(id, 2) % 360) * (Math.PI / 180);
  const star = nodes >= 5 && hash(id, 3) % 2 === 0;
  const radius = 7.6 + (hash(id, 4) % 3) * 0.5;
  const points = Array.from({ length: nodes }, (_, i) => {
    const a = twist + (i / nodes) * Math.PI * 2;
    return [12 + Math.cos(a) * radius, 12 + Math.sin(a) * radius] as const;
  });
  const order = star ? points.map((_, i) => points[(i * 2) % nodes]) : points;
  const d = `${order.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ")}Z`;
  const ring = hash(id, 5) % 3;
  return (
    <svg viewBox="0 0 24 24" x={x} y={y} width={size} height={size} className={`sw-g sw-sigil ${className}`.trim()} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ring === 0 && <circle cx="12" cy="12" r={radius + 2.4} strokeWidth={0.9} strokeDasharray="1.2 2" opacity="0.55" />}
      <g className="sw-sigil-body">
        <path d={d} strokeWidth={1.25} opacity="0.85" />
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i === 0 ? 2 : 1.45} fill="currentColor" stroke="none" />
        ))}
      </g>
      <circle cx="12" cy="12" r={ring === 1 ? 2.6 : 2.1} fill="currentColor" stroke="none" className="sw-core" />
      {ring === 2 && <circle cx="12" cy="12" r="4.2" strokeWidth={0.9} opacity="0.5" />}
    </svg>
  );
}
