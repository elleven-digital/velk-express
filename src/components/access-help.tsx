import { Icon } from "./icons";

/**
 * "Can't sign in?" under the portal login: a gray bar, like a table's header, that opens a white
 * panel with how to reach the agency. Only when the agency set a support e-mail or phone. Plain
 * <details>, so it works without scripts.
 */
export function AccessHelp({
  email,
  phone,
  labels,
}: {
  email: string | null;
  phone: string | null;
  labels: { title: string; body: string; email: string; phone: string };
}) {
  if (!email && !phone) return null;
  // what a phone app dials: the digits, and a leading plus
  const dial = phone ? phone.replace(/(?!^\+)[^\d]/g, "") : "";
  const link = "font-medium text-ink underline-offset-[3px] hover:underline break-all";
  return (
    <details className="group mt-4 rounded-card border border-line bg-white overflow-hidden">
      <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 bg-paper px-4 text-[0.8125rem] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        {labels.title}
        <Icon name="chevron" size={14} className="flex-none transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line px-4 py-3.5 text-[0.875rem]">
        <p className="mb-2.5 text-muted">{labels.body}</p>
        <dl className="space-y-1.5">
          {email ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{labels.email}</dt>
              <dd className="min-w-0">
                <a href={`mailto:${email}`} className={link}>
                  {email}
                </a>
              </dd>
            </div>
          ) : null}
          {phone ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{labels.phone}</dt>
              <dd className="min-w-0">
                <a href={`tel:${dial}`} className={link}>
                  {phone}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </details>
  );
}
