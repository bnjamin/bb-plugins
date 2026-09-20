import net from "node:net";

const server = net.createServer();
server.listen(Number(process.argv[2]), "0.0.0.0");
setTimeout(() => server.close(), 3_000);
