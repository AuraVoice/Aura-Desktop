import type { ReactNode } from "react";

export function SettingsPageLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="db-page db-settings-page">
      <header className="db-settings-page-intro">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="db-settings-page-stack">{children}</div>
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="db-settings-card-section">
      <div className="db-settings-card-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}
