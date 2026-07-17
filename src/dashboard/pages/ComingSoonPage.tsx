interface ComingSoonPageProps {
  title: string;
}

/** Placeholder for sidebar sections without a real page yet. Deliberately an
 * honest empty state rather than fake content (see plan doc for which items map
 * to existing data modules to wire up next). */
export function ComingSoonPage({ title }: ComingSoonPageProps) {
  return (
    <div className="db-coming">
      <h2 className="db-coming-title">{title}</h2>
      <p className="db-muted">This section is coming soon.</p>
    </div>
  );
}
