declare module "*?worker" {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

interface Window {
  MonacoEnvironment?: {
    getWorker(moduleId: string, label: string): Worker;
  };
}
