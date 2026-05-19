import { createContext, useCallback, useContext, useState } from 'react';

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

interface TodoProgressContextType {
  todos: TodoItem[];
  sessionId: string | null;
  setTodos: (todos: TodoItem[], sessionId: string | null) => void;
  clearTodos: () => void;
}

const TodoProgressContext = createContext<TodoProgressContextType>({
  todos: [],
  sessionId: null,
  setTodos: () => {},
  clearTodos: () => {},
});

export function TodoProgressProvider({ children }: { children: React.ReactNode }) {
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const setTodos = useCallback((newTodos: TodoItem[], newSessionId: string | null) => {
    setTodosState(newTodos);
    setSessionId(newSessionId);
  }, []);

  const clearTodos = useCallback(() => {
    setTodosState([]);
    setSessionId(null);
  }, []);

  return (
    <TodoProgressContext.Provider value={{ todos, sessionId, setTodos, clearTodos }}>
      {children}
    </TodoProgressContext.Provider>
  );
}

export function useTodoProgress() {
  return useContext(TodoProgressContext);
}
