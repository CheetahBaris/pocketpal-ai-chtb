import {contentToText, mergeSystemPrompt} from '../prompt';

describe('contentToText', () => {
  it('passes strings through', () => {
    expect(contentToText('hi')).toBe('hi');
  });

  it('joins text parts and ignores other parts', () => {
    expect(
      contentToText([
        {type: 'text', text: 'a'},
        {type: 'image_url', image_url: {url: 'x'}},
        {type: 'text', text: 'b'},
      ]),
    ).toBe('a\nb');
  });

  it('returns empty for unsupported content', () => {
    expect(contentToText(undefined)).toBe('');
    expect(contentToText(null)).toBe('');
    expect(contentToText(42)).toBe('');
  });
});

describe('mergeSystemPrompt', () => {
  it('returns the messages unchanged without a prompt', () => {
    const messages = [
      {role: 'system', content: 'client'},
      {role: 'user', content: 'hi'},
    ];
    expect(mergeSystemPrompt(messages, '   ')).toEqual(messages);
  });

  it('prepends the pal prompt when the client sent none', () => {
    const result = mergeSystemPrompt(
      [{role: 'user', content: 'hi'}],
      'You are a pal.',
    );
    expect(result[0]).toEqual({role: 'system', content: 'You are a pal.'});
    expect(result[1]).toEqual({role: 'user', content: 'hi'});
  });

  it('folds pal and client system messages into one leading message', () => {
    const result = mergeSystemPrompt(
      [
        {role: 'system', content: 'client A'},
        {role: 'user', content: 'hi'},
        {role: 'system', content: 'client B'},
      ],
      'pal',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'pal\n\nclient A\n\nclient B',
    });
    expect(result[1]).toEqual({role: 'user', content: 'hi'});
  });

  it('reads client system content parts', () => {
    const result = mergeSystemPrompt(
      [
        {
          role: 'system',
          content: [{type: 'text', text: 'client'}],
        },
        {role: 'user', content: 'hi'},
      ],
      'pal',
    );
    expect(result[0]).toEqual({role: 'system', content: 'pal\n\nclient'});
  });

  it('leaves a client-only system message in place', () => {
    const result = mergeSystemPrompt(
      [
        {role: 'system', content: 'client'},
        {role: 'user', content: 'hi'},
      ],
      '',
    );
    expect(result).toEqual([
      {role: 'system', content: 'client'},
      {role: 'user', content: 'hi'},
    ]);
  });
});
