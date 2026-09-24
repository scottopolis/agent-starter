import { controlMessage, exactOrigin, parseControlMessage, parsePromptMessage, promptMessage } from '../src/embed/protocol';

describe('widget protocol', () => {
  it('accepts exact HTTP origins and rejects paths or lookalikes', () => {
    expect(exactOrigin('https://chat.example.com')).toBe('https://chat.example.com');
    expect(exactOrigin('https://chat.example.com/path')).toBeUndefined();
    expect(exactOrigin('https://chat.example.com.evil.test')).toBe('https://chat.example.com.evil.test');
    expect(exactOrigin('javascript:alert(1)')).toBeUndefined();
  });

  it('requires strict message shapes', () => {
    expect(parseControlMessage(controlMessage('READY'))).toEqual(controlMessage('READY'));
    expect(parseControlMessage({ ...controlMessage('READY'), extra: true })).toBeUndefined();
    expect(parsePromptMessage(promptMessage('Hello'))).toEqual(promptMessage('Hello'));
    expect(parsePromptMessage(promptMessage('   '))).toBeUndefined();
    expect(parsePromptMessage({ ...promptMessage('Hello'), message: 'x'.repeat(16_001) })).toBeUndefined();
  });
});
