process.stdin.setEncoding("utf8");
process.stdout.write("CHILD-READY\n");
process.stdin.once("data", (data) => {
  process.stdout.write(`CHILD-ECHO:${data.trim()}\n`);
  process.exit(0);
});
process.stdin.resume();
