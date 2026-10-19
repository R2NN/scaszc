from algorithm.tools import transport_network as network


def test_scenario_skips_an_ambiguous_first_edge_and_uses_a_proven_next_edge(monkeypatch):
    monkeypatch.setattr(network, 'catalog', lambda: {'segments': [], 'stations': []})
    edges = [{'id': str(i), 'length': .1, 'begin_shape_index': i, 'end_shape_index': i + 1} for i in range(4)]
    monkeypatch.setattr(network, 'trace_edges', lambda *args: edges)
    attempts = []

    def snap(payload):
        attempts.append(payload['coords'])
        if len(attempts) == 1:
            raise ValueError('Несколько уровней: привязка не доказана')
        return {'id': 'road:2', 'edgeId': '2', 'heading': 90}

    monkeypatch.setattr(network, 'snap', snap)
    choices = network.candidates({'kind': 'road', 'direction': 'forward', 'date': '2026-08-17', 'time': '14:25',
        'team': [{'sourceId': 'E', 'transport': 'CAR'}],
        'raw': {'plan': {'engineer_plans': [{'engineer_id': 'E', 'visits': [{
            'job_id': 'J', 'departure_at': '2026-08-17T14:30:00+03:00',
            'travel': {'distance_m': 1000, 'geometry': [[55.75, 37.6 + i / 1000] for i in range(5)]},
        }]}]}}})
    assert len(attempts) == 2
    assert choices[0]['segment']['edgeId'] == '2'


def test_entry_candidate_is_a_street_entrance_not_a_platform_reached_inside(monkeypatch):
    a, b = [55.75, 37.6], [55.751, 37.601]
    monkeypatch.setattr(network, 'catalog', lambda: {'segments': [], 'stations': [
        {'id': 'm:A', 'coords': a, 'name': 'Вход с улицы'}, {'id': 'm:B', 'coords': b, 'name': 'Внутренняя платформа'},
    ]})
    choices = network.candidates({'kind': 'entry', 'date': '2026-08-17', 'time': '15:45',
        'team': [{'sourceId': 'E', 'transport': 'PUBLIC_TRANSIT'}],
        'raw': {'plan': {'engineer_plans': [{'engineer_id': 'E', 'visits': [{
            'job_id': 'J', 'departure_at': '2026-08-17T15:52:00+03:00', 'travel': {'itinerary': [
                {'mode': 'walking_transfer', 'geometry': [[55.749, 37.599], a], 'duration_seconds': 120, 'attributes': {'source': 'VALHALLA_WALK_MATRIX'}},
                {'mode': 'walking_transfer', 'geometry': [a, b], 'duration_seconds': 180, 'attributes': {'source': 'MOSMETRO_SCHEMA'}},
                {'mode': 'metro', 'geometry': [b, [55.76, 37.61]], 'duration_seconds': 180, 'attributes': {}},
            ]},
        }]}]}}})
    assert choices[0]['segment']['id'] == 'm:A'
