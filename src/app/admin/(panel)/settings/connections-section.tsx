import { ConfirmForm } from "@/components/confirm-form";
import { fillNode } from "@/components/fill-node";
import { Icon } from "@/components/icons";
import { CopyButton } from "@/components/link-box";
import { LocalTime } from "@/components/local-time";
import { SubmitButton } from "@/components/submit-button";
import { Card, SectionTitle } from "@/components/ui";
import { fmt, type Dict, type Locale } from "@/lib/i18n";
import type { ConnectionView } from "@/lib/oauth/store";
import { revokeAiConnectionAction } from "./actions";

const AI_CONNECTOR_GUIDE_URL = "https://github.com/elleven-digital/velk-express/blob/main/docs/ai-connector.md";

/** The connector address to copy, the short steps per app and the full guide. */
function HowToConnect({ connectorUrl, t }: { connectorUrl: string; t: Dict }) {
  const s = t.settings;
  const command = `claude mcp add --transport http velk-express ${connectorUrl}`;
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[0.8125rem] text-muted">{s.aiUrlLabel}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            readOnly
            aria-label={s.aiUrlLabel}
            value={connectorUrl}
            className="min-w-0 flex-1 basis-60 rounded-field border border-line bg-white px-3 py-[7px] font-mono text-[0.8125rem] text-ink"
          />
          <CopyButton text={connectorUrl} label={t.common.copy} copiedLabel={t.common.copied} />
        </div>
      </div>
      <div>
        <div className="text-[0.8125rem] text-muted">{s.aiHowTitle}</div>
        <ul className="mt-1 space-y-1.5 text-[0.875rem] text-ink">
          <li>{s.aiStepClaude}</li>
          <li>
            {fillNode(s.aiStepClaudeCode, {
              command: (
                <code className="mt-1 block w-fit max-w-full break-all rounded-field border border-line bg-paper px-2 py-1 font-mono text-[0.8125rem]">
                  {command}
                </code>
              ),
            })}
          </li>
          <li>{s.aiStepChatGpt}</li>
        </ul>
      </div>
      <a
        href={AI_CONNECTOR_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[0.875rem] font-medium underline underline-offset-2"
      >
        {s.aiGuide}
        <Icon name="ext" size={14} />
      </a>
    </div>
  );
}

/**
 * Settings → AI connections, for every role: the person's own connected apps,
 * each with Revoke, and how to connect one. With no connection the steps show
 * open; with some, they fold under "Connect another app". Without a public
 * address (`connectorUrl` null) there is nothing to connect to, so no steps.
 */
export function ConnectionsSection({
  connections,
  connectorUrl,
  locale,
  t,
}: {
  connections: ConnectionView[];
  connectorUrl: string | null;
  locale: Locale;
  t: Dict;
}) {
  const s = t.settings;
  const howTo = connectorUrl === null ? null : <HowToConnect connectorUrl={connectorUrl} t={t} />;
  return (
    <section aria-labelledby="ai-title" id="ai-connections">
      <SectionTitle className="mb-1">
        <span id="ai-title">{s.aiTitle}</span>
      </SectionTitle>
      <p className="mb-4 text-[0.875rem] text-muted">{s.aiSub}</p>
      <Card className="divide-y divide-line">
        {connections.length > 0 ? (
          <ul className="divide-y divide-line">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[0.875rem] font-medium text-ink">{c.clientName}</p>
                  <p className="text-[0.8125rem] text-muted">
                    {fillNode(s.aiConnected, { date: <LocalTime iso={c.createdAt.toISOString()} locale={locale} /> })}
                    {" · "}
                    {c.lastUsedAt
                      ? fillNode(s.aiLastUsed, { date: <LocalTime iso={c.lastUsedAt.toISOString()} locale={locale} /> })
                      : s.aiNeverUsed}
                  </p>
                </div>
                <ConfirmForm action={revokeAiConnectionAction.bind(null, c.id)} message={fmt(s.aiRevokeConfirm, { app: c.clientName })}>
                  <SubmitButton variant="danger" size="sm">
                    {s.aiRevoke}
                  </SubmitButton>
                </ConfirmForm>
              </li>
            ))}
          </ul>
        ) : null}
        {connections.length === 0 ? (
          <div className="space-y-4 p-4">
            <p className="text-[0.875rem] text-muted">{s.aiNone}</p>
            {howTo}
          </div>
        ) : howTo ? (
          <details className="p-4">
            <summary className="cursor-pointer text-[0.875rem] font-medium text-ink">{s.aiConnectAnother}</summary>
            <div className="mt-3">{howTo}</div>
          </details>
        ) : null}
      </Card>
    </section>
  );
}
