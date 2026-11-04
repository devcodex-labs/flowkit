/** The control marker alone determines identity; kind is owned by the host. */
export const isControlSignal = error => error?.control === true;
