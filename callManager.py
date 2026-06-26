"""
Call Manager - Gestion hybride des appels P2P/SFU
Gère automatiquement le passage de P2P (<4 participants) à SFU (≥4 participants)
"""
import json
import asyncio
from datetime import datetime


class CallManager:

    # SFU not yet implemented — keep P2P for all call sizes for now
    SFU_THRESHOLD = 999

    def __init__(self, db):
        self.db = db
        self.active_calls = {}
        self.conversation_calls = {}
        self.vocal_channel_calls = {}  # vocal_channel_id -> call_id

    def get_active_call_ids_for_user(self, user_id):
        """In-memory call ids where this user is currently a participant.

        Used to clean up after an abrupt WebSocket disconnect (no explicit
        hang-up) so the session doesn't linger forever with active=true.
        """
        return [cid for cid, call in list(self.active_calls.items())
                if user_id in call.participants]

    def get_call_by_conversation(self, conv_id):
        # Try memory first (fast path)
        call_id = self.conversation_calls.get(conv_id)
        if call_id and call_id in self.active_calls:
            return self.active_calls[call_id]

        # Fallback: Load from DB (handles multi-worker scenario)
        call_session = self.db.getFilters("call_session", [
            "conversation_id", "=", conv_id,
            "and", "active", "=", True
        ])

        if call_session and len(call_session) > 0:
            session_data = call_session[0]
            call_id = session_data['id']

            participants = session_data['participants']
            if isinstance(participants, str):
                participants = json.loads(participants)

            call = CallSession(
                call_id,
                session_data['conversation_id'],
                participants,
                session_data['call_type'],
                session_data['mode'],
                session_data.get('vocal_channel_id')
            )

            self.active_calls[call_id] = call
            self.conversation_calls[conv_id] = call_id

            return call

        return None

    def get_call_by_vocal_channel(self, vocal_channel_id):
        call_id = self.vocal_channel_calls.get(vocal_channel_id)
        if call_id and call_id in self.active_calls:
            return self.active_calls[call_id]

        call_session = self.db.getFilters("call_session", [
            "vocal_channel_id", "=", vocal_channel_id,
            "and", "active", "=", True
        ])

        if call_session and len(call_session) > 0:
            session_data = call_session[0]
            call_id = session_data['id']

            participants = session_data['participants']
            if isinstance(participants, str):
                participants = json.loads(participants)

            call = CallSession(
                call_id,
                session_data.get('conversation_id'),
                participants,
                session_data['call_type'],
                session_data['mode'],
                vocal_channel_id
            )

            self.active_calls[call_id] = call
            self.vocal_channel_calls[vocal_channel_id] = call_id
            return call

        return None

    def create_call_for_vocal_channel(self, vocal_channel_id, initiator_id, call_type='audio'):
        existing = self.get_call_by_vocal_channel(vocal_channel_id)
        if existing:
            return self.join_call(existing.id, initiator_id)

        participants = json.dumps([initiator_id])
        # A partial unique index (idx_call_session_active_vocal) guarantees at most
        # one active call per vocal channel. If two users join an empty channel at
        # the same instant, the loser's insert hits ON CONFLICT DO NOTHING and gets
        # no id back — we then just join the call the winner created.
        try:
            call_id = self.db.insertDict('call_session', {
                'vocal_channel_id': vocal_channel_id,
                'participants': participants,
                'call_type': call_type,
                'mode': 'p2p',
                'active': True
            }, getId=True)
        except Exception:
            call_id = None

        if not call_id:
            existing = self.get_call_by_vocal_channel(vocal_channel_id)
            if existing:
                return self.join_call(existing.id, initiator_id)
            return None

        call = CallSession(call_id, None, [initiator_id], call_type, vocal_channel_id=vocal_channel_id)
        self.active_calls[call_id] = call
        self.vocal_channel_calls[vocal_channel_id] = call_id

        return {'call': call, 'mode_changed': False, 'created': True}

    def create_call(self, conv_id, initiator_id, call_type='audio'):
        existing_call = self.get_call_by_conversation(conv_id)
        if existing_call:
            return existing_call

        participants = json.dumps([initiator_id])
        call_id = self.db.insertDict('call_session', {
            'conversation_id': conv_id,
            'participants': participants,
            'call_type': call_type,
            'mode': 'p2p',
            'active': True
        }, getId=True)

        call = CallSession(call_id, conv_id, [initiator_id], call_type)
        self.active_calls[call_id] = call
        self.conversation_calls[conv_id] = call_id

        return call

    def join_call(self, call_id, user_id):
        call = self.active_calls.get(call_id)

        # If not in memory, try to load from DB
        if not call:
            call_session = self.db.getSomething("call_session", call_id)
            if call_session and call_session.get('active'):
                # participants is jsonb in PostgreSQL, already deserialized to list
                participants = call_session['participants']
                if isinstance(participants, str):
                    participants = json.loads(participants)

                call = CallSession(
                    call_id,
                    call_session.get('conversation_id'),
                    participants,
                    call_session['call_type'],
                    call_session['mode'],
                    call_session.get('vocal_channel_id')
                )
                # Cache in memory
                self.active_calls[call_id] = call
                if call.conversation_id:
                    self.conversation_calls[call.conversation_id] = call_id
                if call.vocal_channel_id:
                    self.vocal_channel_calls[call.vocal_channel_id] = call_id
            else:
                return None

        if user_id not in call.participants:
            call.participants.append(user_id)

            old_mode = call.mode
            if len(call.participants) >= self.SFU_THRESHOLD:
                call.mode = 'sfu'

            participants_json = json.dumps(call.participants)
            self.db.edit('call_session', call_id, 'participants', participants_json)
            self.db.edit('call_session', call_id, 'mode', call.mode)

            result = {
                'call': call,
                'mode_changed': old_mode != call.mode,
                'old_mode': old_mode,
                'new_mode': call.mode
            }
            return result

        return {'call': call, 'mode_changed': False}

    def leave_call(self, call_id, user_id):
        call = self.active_calls.get(call_id)

        # If not in memory, try to load from DB
        if not call:
            call_session = self.db.getSomething("call_session", call_id)
            if call_session and call_session.get('active'):
                # participants is jsonb in PostgreSQL, already deserialized to list
                participants = call_session['participants']
                if isinstance(participants, str):
                    participants = json.loads(participants)

                call = CallSession(
                    call_id,
                    call_session.get('conversation_id'),
                    participants,
                    call_session['call_type'],
                    call_session['mode'],
                    call_session.get('vocal_channel_id')
                )
                # Cache in memory
                self.active_calls[call_id] = call
                if call.conversation_id:
                    self.conversation_calls[call.conversation_id] = call_id
                if call.vocal_channel_id:
                    self.vocal_channel_calls[call.vocal_channel_id] = call_id
            else:
                return None

        if user_id in call.participants:
            call.participants.remove(user_id)

            old_mode = call.mode

            if len(call.participants) == 0:
                return self.end_call(call_id)

            if len(call.participants) < self.SFU_THRESHOLD:
                call.mode = 'p2p'

            participants_json = json.dumps(call.participants)
            self.db.edit('call_session', call_id, 'participants', participants_json)
            self.db.edit('call_session', call_id, 'mode', call.mode)

            return {
                'call': call,
                'mode_changed': old_mode != call.mode,
                'old_mode': old_mode,
                'new_mode': call.mode,
                'ended': False
            }

        return {'call': call, 'mode_changed': False, 'ended': False}

    def end_call(self, call_id):
        call = self.active_calls.get(call_id)
        if not call:
            return None

        self.db.edit('call_session', call_id, 'active', False)
        self.db.edit('call_session', call_id, 'ended_at', datetime.now())

        conv_id = call.conversation_id
        vchan_id = call.vocal_channel_id
        del self.active_calls[call_id]
        if conv_id and conv_id in self.conversation_calls:
            del self.conversation_calls[conv_id]
        if vchan_id and vchan_id in self.vocal_channel_calls:
            del self.vocal_channel_calls[vchan_id]

        return {'call': call, 'ended': True}

    def get_call_state(self, conv_id):
        call = self.get_call_by_conversation(conv_id)
        if call:
            return call.to_dict()
        return None

    async def forward_stream_sfu(self, call_id, from_user, stream_data):
        call = self.active_calls.get(call_id)
        if not call or call.mode != 'sfu':
            return None

        recipients = [p for p in call.participants if p != from_user]

        return {
            'recipients': recipients,
            'stream_data': stream_data
        }


class CallSession:
    def __init__(self, call_id, conversation_id, participants, call_type='audio', mode=None, vocal_channel_id=None):
        self.id = call_id
        self.conversation_id = conversation_id
        self.vocal_channel_id = vocal_channel_id
        self.participants = participants  # Liste d'IDs utilisateurs
        self.call_type = call_type  # 'audio' ou 'video'
        # Use provided mode or calculate based on participants
        self.mode = mode if mode is not None else ('p2p' if len(participants) < CallManager.SFU_THRESHOLD else 'sfu')
        self.started_at = datetime.now()

        self.streams = {}  # {user_id: stream_info}

    def to_dict(self):
        return {
            'id': self.id,
            'conversation_id': self.conversation_id,
            'vocal_channel_id': self.vocal_channel_id,
            'participants': self.participants,
            'participant_count': len(self.participants),
            'call_type': self.call_type,
            'mode': self.mode,
            'active': True,
            'started_at': self.started_at.isoformat()
        }

