import { PageShell } from '@shared/components/page-shell'
import { AboutSection } from './components/AboutSection'

function Company() {
  return (
    <PageShell>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h1 className="heading-hero text-foreground">Pivotal</h1>
          <p className="max-w-xl text-base text-muted-foreground">
            Unlocking coordinated intelligence.
          </p>
        </div>
      </div>

      <AboutSection
        className="bg-transparent -mt-12 px-0 pb-6 sm:-mt-16 sm:px-0 sm:pb-8"
        contentClassName="max-w-none"
        headingAlign="left"
        layout="stack"
        title={null}
        contentSpacingClass="space-y-0"
        itemsGapClass="gap-5 sm:gap-6"
      />
    </PageShell>
  )
}

export default Company
