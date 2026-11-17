process.on('message', prepared => {
  process.send({ status: 'succeeded', result: { pid: process.pid, cwd: process.cwd(), value: prepared.task.input.value },
    events: [{ type: 'scripted-worker-result' }] });
});
