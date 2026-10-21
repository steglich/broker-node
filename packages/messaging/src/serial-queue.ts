/** Executa as tarefas uma de cada vez, na ordem de chegada (processamento em série por partição). */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Espera tudo o que já foi enfileirado. */
  idle(): Promise<void> {
    return this.tail;
  }
}
