export function AuthHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-8 grid gap-2">
      <h1 className="type-display text-[2.5rem]">{title}</h1>
      {description && <p className="text-[15px] leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}
