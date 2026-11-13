/**
 * A Realtime server in miniature, for the chat view's agent tests: each
 * response.create answers with the next scripted response; everything the
 * client sent is kept. `call` and `say` write a response's items.
 */
export function fakeRealtime(script) {
  const sent = [];
  let socket = null;
  const connect = (url, protocols) => {
    socket = {
      url,
      protocols,
      readyState: 0,
      send(raw) {
        const event = JSON.parse(raw);
        sent.push(event);
        if (event.type === 'conversation.item.create') {
          const id = `item_${sent.length}`;
          queueMicrotask(() =>
            socket.onmessage({
              data: JSON.stringify({
                type: 'conversation.item.added',
                item: { id },
              }),
            }),
          );
        }
        if (event.type !== 'response.create') return;
        const output = script.shift() || [];
        const id = `resp_${sent.length}`;
        queueMicrotask(() => {
          socket.onmessage({
            data: JSON.stringify({
              type: 'response.created',
              response: { id },
            }),
          });
          socket.onmessage({
            data: JSON.stringify({
              type: 'response.done',
              response: { id, status: 'completed', output },
            }),
          });
        });
      },
      close() {
        socket.readyState = 3;
        socket.onclose?.();
      },
    };
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.onopen();
    });
    return socket;
  };
  return { connect, sent, socket: () => socket };
}

export const call = (name, args, id = 'call_1') => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
export const say = (text) => ({
  type: 'message',
  content: [{ type: 'output_text', text }],
});
