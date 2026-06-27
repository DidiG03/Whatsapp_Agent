import { fetchUnreadCountsForContacts, listMessagesForThread } from '../../src/services/conversations.mjs';
import { Message, MessageStatus } from '../../src/schemas/mongodb.mjs';

jest.mock('../../src/schemas/mongodb.mjs', () => ({
  Message: {
    find: jest.fn(),
    aggregate: jest.fn(),
  },
  Handoff: {},
  MessageStatus: {
    aggregate: jest.fn(),
  },
}));

describe('conversations performance helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('listMessagesForThread loads newest messages only', async () => {
    const lean = jest.fn().mockResolvedValue([
      { direction: 'inbound', text_body: 'new', timestamp: 3, type: 'text' },
      { direction: 'outbound', text_body: 'old', timestamp: 1, type: 'text' },
    ]);
    const limit = jest.fn().mockReturnValue({ lean });
    Message.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({ limit }),
      }),
    });

    const rows = await listMessagesForThread('user-1', '15551234567', { limit: 2 });
    expect(Message.find).toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith(2);
    expect(rows).toEqual([
      { direction: 'outbound', text_body: 'old', type: 'text', ts: 1 },
      { direction: 'inbound', text_body: 'new', type: 'text', ts: 3 },
    ]);
  });

  test('fetchUnreadCountsForContacts uses one facet aggregation', async () => {
    Message.aggregate.mockResolvedValue([{
      '+15551111111': [{ count: 2 }],
      '+15552222222': [{ count: 0 }],
    }]);

    const lastSeen = new Map([
      ['+15551111111', 100],
      ['+15552222222', 200],
    ]);
    const contacts = [
      { contact: '+15551111111' },
      { contact: '+15552222222' },
    ];

    const counts = await fetchUnreadCountsForContacts('user-1', contacts, lastSeen);
    expect(Message.aggregate).toHaveBeenCalledTimes(1);
    expect(counts.get('+15551111111')).toBe(2);
    expect(counts.get('+15552222222')).toBe(0);
  });
});
