import { IbhChat } from './component';
import * as types from './types';

export { ibhChat } from './directive';
export { IbhChat } from './component';
export * from './types';

// JSX directive typing: enables `use:ibhChat={...}` with full type checking.
declare module 'solid-js' {
  namespace JSX {
    interface Directives {
      ibhChat: types.IbhChatProps;
    }
  }
}

export default IbhChat;
