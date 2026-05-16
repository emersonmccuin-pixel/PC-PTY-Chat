import { WorkItemsList } from '@/components/work-items-list';

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Project Companion</h1>
      </header>
      <main>
        <WorkItemsList />
      </main>
    </div>
  );
}
