import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <h1 className="text-2xl font-semibold">Project Companion</h1>
      <p className="mt-1 text-muted-foreground">
        Scaffold up. shadcn primitives wired. Panels next.
      </p>

      <Card className="mt-6 max-w-md">
        <CardHeader>
          <CardTitle>shadcn smoke test</CardTitle>
          <CardDescription>Button, Card, Badge — all themed via CSS vars.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Badge>OK</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
