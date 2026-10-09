import { useEffect, useRef, useState } from "react";
import { MAX_REPO_SCOPES, type SwarmRoster } from "../../../lib/swarmApi";
import { ConnectorReauthorizationRequiredError, GitHubRateLimitedError, fetchGitHubRepos, type GitHubRepos } from "../../../lib/connectors";
import { useOutsideClick } from "../../components/useOutsideClick";
import { GitHubBrandIcon } from "../../components/connectorBrandIcons";
import { CONNECTOR_LABEL, SWARM_CONNECTORS } from "./SwarmWork";
import { AddGlyph, DismissGlyph, LockGlyph, WebGlyph } from "./SwarmGlyphs";
import type { ChannelView } from "./SwarmStream";

/** The pill row above the composer: which connected accounts the recipient can read while
 * answering this message. In a manager's DM every granted connector is a pill with an x
 * that revokes it, and "+" lists the rest of the account's connected ones to grant. In
 * #group the pills are the union across active managers and only inform: grants are per
 * manager, so they are changed from a DM. The one exception is the GitHub repo scope,
 * which #group applies to every active manager that can read GitHub. The grant itself is the same
 * PUT /swarm/managers/{id}/grants as the Team panel's switches; this is a second view of
 * that state, not a second store.
 *
 * GitHub carries a repo scope. With none picked the pill reads "GitHub" and opens the
 * repositories the installation grants (GET /connectors/github/repos, fetched once per
 * mount, not per click). Each picked repository is its own pill with the GitHub mark,
 * at most three per manager, with "+" beside them until the third. The scope is stored
 * on the grants doc and the planner and step prompts name those repositories first. */

const MAX_REPOS = MAX_REPO_SCOPES;

function ConnectorIcon({ connector }: { connector: string }) {
  const Icon = SWARM_CONNECTORS[connector]?.Icon;
  return Icon ? <Icon size={14} className="db-swarm-scope-icon" /> : <WebGlyph size={14} className="db-swarm-scope-icon" />;
}

type RepoState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; repos: GitHubRepos } | { kind: "error"; message: string };

function repoErrorCopy(err: unknown): string {
  if (err instanceof GitHubRateLimitedError) return "GitHub is rate limiting Aura. Try again in a minute.";
  if (err instanceof ConnectorReauthorizationRequiredError) return "GitHub needs reconnecting from Connectors.";
  return "Could not load repositories.";
}

/** The repository list is fetched the first time it is wanted and then kept for the life
 * of the composer: opening the picker again never costs another GitHub call. An error
 * is retried only when the picker is opened again. */
function useGitHubRepos(wanted: boolean): RepoState {
  const [state, setState] = useState<RepoState>({ kind: "idle" });
  useEffect(() => {
    if (!wanted || state.kind === "loading" || state.kind === "ready") return;
    let live = true;
    setState({ kind: "loading" });
    fetchGitHubRepos()
      .then((repos) => { if (live) setState({ kind: "ready", repos }); })
      .catch((err: unknown) => { if (live) setState({ kind: "error", message: repoErrorCopy(err) }); });
    return () => { live = false; };
    // Re-run only when the picker is opened; a settled fetch is kept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return state;
}

/** The GitHub picker: the installation's repositories, the picked ones checked. */
function RepoPicker({
  state,
  picked,
  onPick,
  onClose,
}: {
  state: RepoState;
  picked: string[];
  onPick: (fullName: string) => void;
  onClose: () => void;
}) {
  const full = picked.length >= MAX_REPOS;
  return (
    <div className="db-swarm-scope-menu is-repos" role="dialog" aria-label="Choose repositories">
      <div className="db-swarm-scope-menu-head">
        <span>{full ? `Up to ${MAX_REPOS} repositories` : "Repositories to read first"}</span>
        <button type="button" className="db-swarm-scope-remove" aria-label="Close" onClick={onClose}><DismissGlyph size={13} /></button>
      </div>
      {(state.kind === "loading" || state.kind === "idle") && <p className="db-swarm-scope-menu-note">Loading</p>}
      {state.kind === "error" && <p className="db-swarm-scope-menu-note">{state.message}</p>}
      {state.kind === "ready" && state.repos.repos.length === 0 && (
        <p className="db-swarm-scope-menu-note">GitHub is connected but not installed on any repository yet. Choose repositories in Connectors.</p>
      )}
      {state.kind === "ready" && state.repos.repos.length > 0 && (
        <ul className="db-swarm-scope-repos">
          {state.repos.repos.map((repo) => {
            const on = picked.includes(repo.fullName);
            return (
              <li key={repo.fullName}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={`db-swarm-scope-repo${on ? " is-on" : ""}`}
                  disabled={!on && full}
                  onClick={() => onPick(repo.fullName)}
                >
                  <GitHubBrandIcon size={13} className="db-swarm-scope-icon" />
                  <span className="db-swarm-scope-repo-name">{repo.fullName}</span>
                  {repo.private && <span title="Private" aria-label="Private" role="img"><LockGlyph size={12} /></span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {state.kind === "ready" && state.repos.truncated && (
        <p className="db-swarm-scope-menu-note">Showing the first {state.repos.repos.length} of {state.repos.total}.</p>
      )}
    </div>
  );
}

export function ComposerGrants({
  view,
  roster,
  grants,
  grantable,
  repoScopes,
  pending,
  onToggleGrant,
  onRepoScope,
}: {
  view: ChannelView;
  roster: SwarmRoster;
  grants: Record<string, string[]>;
  grantable: string[];
  repoScopes: Record<string, string[]>;
  pending: boolean;
  onToggleGrant: (managerId: string, connector: string, on: boolean) => void;
  onRepoScope: (managerId: string, repos: string[]) => void;
}) {
  // One popover at a time: the "+" grant menu or the GitHub repository picker.
  const [open, setOpen] = useState<"add" | "repos" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const reposRef = useRef<HTMLButtonElement | null>(null);
  useOutsideClick(menuRef, () => setOpen(null), open !== null, open === "repos" ? reposRef : addRef);

  const managerId = view.kind === "manager" ? view.manager?.id ?? "" : "";
  const editable = view.kind === "manager" && managerId !== "";
  const managers = editable
    ? roster.managers.filter((m) => m.id === managerId)
    : roster.managers.filter((m) => m.status === "active");

  // Which managers can read each connector, in grantable order so the row is stable.
  const readers = new Map<string, string[]>();
  for (const manager of managers) {
    for (const connector of grants[manager.id] ?? []) {
      readers.set(connector, [...(readers.get(connector) ?? []), manager.name || manager.title]);
    }
  }
  const order = (connector: string) => {
    const index = grantable.indexOf(connector);
    return index === -1 ? grantable.length : index;
  };
  const granted = [...readers.keys()].sort((a, b) => order(a) - order(b));
  const available = editable ? grantable.filter((c) => !readers.has(c)) : [];

  // The repo scope: this manager's in a DM, the union in #group. In #group a pick
  // applies to every active manager that can read GitHub, so the pill works there too.
  const githubManagerIds = editable ? [managerId] : managers.filter((m) => (grants[m.id] ?? []).includes("github")).map((m) => m.id);
  const repoEditable = githubManagerIds.length > 0;
  const picked = editable
    ? (repoScopes[managerId] ?? []).slice(0, MAX_REPOS)
    : [...new Set(managers.flatMap((m) => repoScopes[m.id] ?? []))].slice(0, MAX_REPOS);
  const repos = useGitHubRepos(open === "repos");

  if (granted.length === 0 && available.length === 0) return null;

  const scopeRepos = (next: string[]) => {
    for (const id of githubManagerIds) onRepoScope(id, next);
  };
  const pickRepo = (fullName: string) => {
    const next = picked.includes(fullName) ? picked.filter((r) => r !== fullName) : [...picked, fullName].slice(0, MAX_REPOS);
    setOpen(null);
    scopeRepos(next);
  };

  const picker = open === "repos" && (
    <div ref={menuRef} className="db-swarm-scope-anchor">
      <RepoPicker state={repos} picked={picked} onPick={pickRepo} onClose={() => setOpen(null)} />
    </div>
  );

  return (
    <div className="db-swarm-scope" aria-label="What can be read for this message">
      {granted.map((connector) => {
        const label = CONNECTOR_LABEL[connector] ?? connector;
        const who = readers.get(connector) ?? [];
        const title = editable ? `${label}: ${who[0]} can read it` : `${label}: ${who.join(", ")} can read it`;
        const remove = editable && (
          <button
            type="button"
            className="db-swarm-scope-remove"
            disabled={pending}
            aria-label={`Stop ${who[0]} reading ${label}`}
            onClick={() => onToggleGrant(managerId, connector, false)}
          >
            <DismissGlyph size={13} />
          </button>
        );
        if (connector !== "github") {
          return (
            <span key={connector} className="db-swarm-scope-chip">
              <span className="db-swarm-scope-chip-btn" title={title}>
                <ConnectorIcon connector={connector} />
                {label}
              </span>
              {remove}
            </span>
          );
        }
        if (picked.length === 0) {
          // No repository picked yet: the pill is GitHub itself and opens the picker.
          return (
            <span key={connector} className={`db-swarm-scope-chip${repoEditable ? " is-clickable" : ""}`}>
              {repoEditable ? (
                <button
                  ref={reposRef}
                  type="button"
                  className="db-swarm-scope-chip-btn"
                  disabled={pending}
                  aria-haspopup="dialog"
                  aria-expanded={open === "repos"}
                  title={`${title}. Click to pick the repositories to read first.`}
                  onClick={() => setOpen((v) => (v === "repos" ? null : "repos"))}
                >
                  <ConnectorIcon connector={connector} />
                  {label}
                </button>
              ) : (
                <span className="db-swarm-scope-chip-btn" title={title}>
                  <ConnectorIcon connector={connector} />
                  {label}
                </span>
              )}
              {remove}
              {picker}
            </span>
          );
        }
        // Repositories picked: one pill each, then + until the third.
        return (
          <span key={connector} className="db-swarm-scope-group">
            {picked.map((fullName) => (
              <span key={fullName} className="db-swarm-scope-chip" title={editable ? `${who[0]} reads ${fullName} first` : `${who.join(", ")}: ${fullName}`}>
                <span className="db-swarm-scope-chip-btn">
                  <GitHubBrandIcon size={14} className="db-swarm-scope-icon" />
                  {fullName}
                </span>
                {repoEditable && (
                  <button
                    type="button"
                    className="db-swarm-scope-remove"
                    disabled={pending}
                    aria-label={`Remove ${fullName}`}
                    onClick={() => scopeRepos(picked.filter((r) => r !== fullName))}
                  >
                    <DismissGlyph size={13} />
                  </button>
                )}
              </span>
            ))}
            {repoEditable && picked.length < MAX_REPOS && (
              <span className="db-swarm-scope-add-wrap">
                <button
                  ref={reposRef}
                  type="button"
                  className="db-swarm-scope-add"
                  disabled={pending}
                  aria-haspopup="dialog"
                  aria-expanded={open === "repos"}
                  aria-label="Add another repository"
                  title={`Add another repository (up to ${MAX_REPOS})`}
                  onClick={() => setOpen((v) => (v === "repos" ? null : "repos"))}
                >
                  <AddGlyph size={15} />
                </button>
                {picker}
              </span>
            )}
          </span>
        );
      })}
      {editable && available.length > 0 && (
        <span className="db-swarm-scope-add-wrap">
          <button
            ref={addRef}
            type="button"
            className="db-swarm-scope-add"
            disabled={pending}
            aria-haspopup="menu"
            aria-expanded={open === "add"}
            aria-label="Let this manager read another connected account"
            title="Let this manager read another connected account"
            onClick={() => setOpen((v) => (v === "add" ? null : "add"))}
          >
            <AddGlyph size={15} />
          </button>
          {open === "add" && (
            <div ref={menuRef} className="db-swarm-scope-menu" role="menu" aria-label="Connected accounts to grant">
              {available.map((connector) => (
                <button
                  key={connector}
                  type="button"
                  role="menuitem"
                  className="db-swarm-scope-menu-row"
                  onClick={() => {
                    setOpen(null);
                    onToggleGrant(managerId, connector, true);
                  }}
                >
                  <ConnectorIcon connector={connector} />
                  {CONNECTOR_LABEL[connector] ?? connector}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
