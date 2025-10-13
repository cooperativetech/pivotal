import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/components/ui/card'
import { cn } from '@shared/lib/utils'

type AboutItem = {
  title: string
  intro?: string
  paragraphs?: string[]
  bullets?: string[]
}

const aboutItems: AboutItem[] = [
  {
    title: 'Our mission',
    paragraphs: [
      "We believe that harnessing humanity's collective intelligence and unlocking group coordination are critical and underexplored approaches to AI safety. Current UI tools across chat, coding, service, and legal advice have focused on one person <-> LLM interactions. We are building the interface for many person <-> LLM use cases.",
    ],
  },
  {
    title: 'Our product',
    paragraphs: [
      "We have built a multi-agent orchestration tool for coordination. Pivotal is an activity log, a shared context, and an agent platform for organizations. It integrates with the software you already use, automates workflows that might otherwise fall through the cracks, and keeps your team on track with a cohesive plan. You can use Pivotal to schedule a Google Meet with a single Slack message, and have it automatically update your GitHub work tracker based on everything mentioned in the meeting. Never forget an action item again!",
    ],
  },
  {
    title: 'Our team',
    intro: 'Builders and researchers from MIT, Oxford, and industry working on human coordination and AI safety.',
    bullets: [
      'Anand Shah is an EconCS PhD candidate at MIT, studying topics in market design and the economics of AI. His research primarily focuses on platforms and synthetic data generation for economic theory.',
      'Parker Whitfill is an Economics PhD candidate at MIT, studying topics at the intersection of labor and AI. He is interested in the substitutability between human and machine labor and the design of quality evals.',
      'Kai Sandbrink is a PhD candidate in computational cognitive neuroscience at the University of Oxford. His research focuses on using deep learning as models for human knowledge acquisition and decision-making. He also is working on projects in AI for human coordination.',
      'Ben Sklaroff is a software engineer focused on democratizing the economy as a key AI safety measure. He was previously the CTO and co-founder of Genesis Therapeutics, an ML-accelerated biotech, and before that head of software at Markforged, developing high-strength 3D printers.',
    ],
  },
]

type AboutSectionProps = {
  className?: string
  contentClassName?: string
  headingAlign?: 'left' | 'center'
  layout?: 'grid' | 'stack'
  title?: string | null
  titleClassName?: string
  sectionId?: string
  onTitleClick?: () => void
  contentId?: string
  contentSpacingClass?: string
  itemsGapClass?: string
}

export function AboutSection({
  className,
  contentClassName,
  headingAlign = 'center',
  layout = 'grid',
  title = 'About Us',
  titleClassName = 'text-3xl font-semibold text-foreground',
  sectionId,
  onTitleClick,
  contentId,
  contentSpacingClass = 'space-y-14',
  itemsGapClass,
}: AboutSectionProps) {
  const headingAlignmentClass = headingAlign === 'center' ? 'text-center' : 'text-left'
  const resolvedGapClass = itemsGapClass ?? (layout === 'stack' ? 'gap-6 sm:gap-8' : 'gap-6')
  const resolvedGridColumns = layout === 'stack' ? 'grid md:grid-cols-1' : 'grid md:grid-cols-3'
  const cardLayoutClass = cn(resolvedGridColumns, resolvedGapClass)

  return (
    <section
      id={sectionId}
      className={cn(
        'bg-background px-6 pb-20 pt-16 text-foreground sm:pb-28 sm:pt-20',
        className,
      )}
    >
      <div className={cn('mx-auto w-full max-w-5xl', contentSpacingClass, contentClassName)}>
        {title ? (
          <div className={cn('space-y-4', headingAlignmentClass)}>
            <h2
              className={cn(
                titleClassName,
                onTitleClick &&
                  'cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
              onClick={onTitleClick}
            >
              {title}
            </h2>
          </div>
        ) : null}
        <div id={contentId} className={cardLayoutClass}>
          {aboutItems.map((item) => (
            <Card key={item.title} className="h-full border-token bg-surface shadow-sm">
              <CardHeader className="space-y-3">
                <CardTitle className="heading-card text-[color:var(--p-root)]">{item.title}</CardTitle>
                {item.intro && (
                  <CardDescription className="text-sm text-muted-foreground">
                    {item.intro}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                {item.paragraphs?.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {item.bullets && (
                  <ul className="space-y-3">
                    {item.bullets.map((bullet) => (
                      <li
                        key={bullet}
                        className="relative pl-6 text-sm text-muted-foreground before:absolute before:left-0 before:top-2 before:h-2.5 before:w-2.5 before:rounded-full before:bg-[color:var(--p-leaf)] before:content-['']"
                      >
                        {bullet}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export const ABOUT_SECTION_ITEMS = aboutItems
