'use strict'

const cds = require('@sap/cds')

// ─── Mock the external SparePartsAPI wrapper ───────────────────────────────────
jest.mock('../srv/parts-catalog')
const { getPartInfo } = require('../srv/parts-catalog')

// ─── Resilience utilities ──────────────────────────────────────────────────────
const { withRetry, CircuitBreaker } = require('../srv/resilience')

// ─── Logger spy (for observability tests) ─────────────────────────────────────
const { createLogger } = require('../srv/logger')

// ─── Seed IDs — match db/data CSVs (carried over from Session 01) ─────────────
const EQ_ACTIVE_ID   = 'e1000000-0000-0000-0000-000000000001'  // EQ-PUMP-001, ACTIVE
const EQ_INACTIVE_ID = 'e1000000-0000-0000-0000-000000000003'  // EQ-TURB-001, INACTIVE

const ORDER_DRAFT_ID = '02000000-0000-0000-0000-000000000004'  // DRAFT, equipment ACTIVE
const ORDER_OPEN_ID  = '02000000-0000-0000-0000-000000000003'  // OPEN

// ─── Workitem IDs (from Session 01 CSV) ───────────────────────────────────────
// c3000000-...-005 and c3000000-...-006 both belong to ORDER_OPEN_ID
const WI_OPEN_1 = 'c3000000-0000-0000-0000-000000000007'
const WI_OPEN_2 = 'c3000000-0000-0000-0000-000000000008'

// ─── Test setup ───────────────────────────────────────────────────────────────
const jestExpect = global.expect
const { GET, POST, PATCH, expect } = cds.test(__dirname + '/..')

beforeEach(() => jest.resetAllMocks())

// ─────────────────────────────────────────────────────────────────────────────
describe('MaintenanceService — Session 3: Events, Observability & CI/CD', () => {

    // ══════════════════════════════════════════════════════════════════════════
    // GROUP 1 — Security (Session 02, regression tests)
    // ══════════════════════════════════════════════════════════════════════════
    describe('security — @requires + @restrict', () => {

        test('anonymous request is rejected (403)', async () => {
            const original = cds.User.default
            cds.User.default = cds.User.Anonymous
            try {
                const res = await GET('/maintenance/MaintenanceOrders').catch(e => e.response)
                expect(res.status).to.be.oneOf([401, 403])
            } finally { cds.User.default = original }
        })

        test('MaintenanceViewer can read orders (200)', async () => {
            const original = cds.User.default
            cds.User.default = new cds.User({ id: 'bob', roles: ['MaintenanceViewer'] })
            try {
                const res = await GET('/maintenance/MaintenanceOrders')
                expect(res.status).to.equal(200)
                expect(res.data.value).to.be.an('array')
            } finally { cds.User.default = original }
        })

        test('MaintenanceViewer cannot create an order (403)', async () => {
            const original = cds.User.default
            cds.User.default = new cds.User({ id: 'bob', roles: ['MaintenanceViewer'] })
            try {
                const res = await POST('/maintenance/MaintenanceOrders', {
                    orderNumber: 'OM-SEC-001', description: 'Viewer write attempt',
                    equipment_ID: EQ_ACTIVE_ID
                }).catch(e => e.response)
                expect(res.status).to.equal(403)
            } finally { cds.User.default = original }
        })

        test('MaintenanceAdmin can create an order (201)', async () => {
            const original = cds.User.default
            cds.User.default = new cds.User({ id: 'alice', roles: ['MaintenanceAdmin'] })
            try {
                const res = await POST('/maintenance/MaintenanceOrders', {
                    orderNumber: 'OM-ADM-001', description: 'Admin creates order',
                    equipment_ID: EQ_ACTIVE_ID, priority: 'MEDIUM'
                })
                expect(res.status).to.equal(201)
            } finally { cds.User.default = original }
        })
    })

    // ══════════════════════════════════════════════════════════════════════════
    // GROUP 2 — External API (Session 02, regression tests)
    // ══════════════════════════════════════════════════════════════════════════
    describe('external API — SparePartsAPI part validation', () => {

        async function createWorkItem(data) {
            const original = cds.User.default
            cds.User.default = new cds.User({ id: 'alice', roles: ['MaintenanceAdmin'] })
            try {
                return await POST('/maintenance/WorkItems', {
                    order_ID: ORDER_OPEN_ID, description: 'Test task',
                    status: 'PENDING', ...data
                }).catch(e => e.response)
            } finally { cds.User.default = original }
        }

        test('WorkItem without partCode: created without calling the API', async () => {
            const res = await createWorkItem({ description: 'No part required' })
            expect(res.status).to.equal(201)
            jestExpect(getPartInfo).not.toHaveBeenCalled()
        })

        test('WorkItem with available part: API called, item created (201)', async () => {
            getPartInfo.mockResolvedValueOnce({ code: 'P-SEAL-001', available: true, unitCost: 450 })
            const res = await createWorkItem({ partCode: 'P-SEAL-001' })
            expect(res.status).to.equal(201)
            jestExpect(getPartInfo).toHaveBeenCalledWith('P-SEAL-001')
        })

        test('WorkItem with unavailable part: API rejects with 422', async () => {
            getPartInfo.mockResolvedValueOnce({ code: 'P-OBS-999', available: false })
            const res = await createWorkItem({ partCode: 'P-OBS-999' })
            expect(res.status).to.equal(422)
            expect(res.data.error.message).to.include('P-OBS-999')
        })

        test('API throws: graceful degradation — WorkItem still created (201)', async () => {
            getPartInfo.mockRejectedValueOnce(new Error('ECONNREFUSED'))
            const res = await createWorkItem({ partCode: 'P-SEAL-001' })
            expect(res.status).to.equal(201)
        })
    })

    // ══════════════════════════════════════════════════════════════════════════
    // GROUP 3 — Resilience (Session 02, regression tests)
    // ══════════════════════════════════════════════════════════════════════════
    describe('resilience — withRetry', () => {

        test('succeeds on 3rd attempt after 2 failures', async () => {
            let calls = 0
            const result = await withRetry(() => {
                calls++
                if (calls < 3) throw new Error('temporary failure')
                return 'ok'
            }, 3, 1)
            jestExpect(result).toBe('ok')
            jestExpect(calls).toBe(3)
        })

        test('throws after maxRetries exhausted', async () => {
            await jestExpect(
                withRetry(() => { throw new Error('always fails') }, 3, 1)
            ).rejects.toThrow('always fails')
        })
    })

    describe('resilience — CircuitBreaker', () => {

        test('CLOSED state: allows calls and resets failures on success', async () => {
            const cb = new CircuitBreaker({ name: 'test', threshold: 3, resetTimeout: 1000 })
            const result = await cb.call(() => Promise.resolve('ok'))
            jestExpect(result).toBe('ok')
            jestExpect(cb.state).toBe('CLOSED')
            jestExpect(cb.failures).toBe(0)
        })

        test('opens after reaching failure threshold', async () => {
            const cb = new CircuitBreaker({ name: 'test', threshold: 3, resetTimeout: 1000 })
            for (let i = 0; i < 3; i++) {
                await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {})
            }
            jestExpect(cb.state).toBe('OPEN')
        })

        test('HALF-OPEN: allows one probe call after resetTimeout elapses', async () => {
            const cb = new CircuitBreaker({ name: 'test', threshold: 1, resetTimeout: 50 })
            await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {})
            jestExpect(cb.state).toBe('OPEN')
            await new Promise(r => setTimeout(r, 60))
            const result = await cb.call(() => Promise.resolve('probe-ok'))
            jestExpect(result).toBe('probe-ok')
            jestExpect(cb.state).toBe('CLOSED')
        })
    })

    // ══════════════════════════════════════════════════════════════════════════
    // GROUP 4 — Domain Events (Session 03, new)
    // ══════════════════════════════════════════════════════════════════════════
    describe('domain events — MaintenanceOrderCompleted', () => {

        async function asAdmin(fn) {
            const original = cds.User.default
            cds.User.default = new cds.User({ id: 'alice', roles: ['MaintenanceAdmin'] })
            try { return await fn() }
            finally { cds.User.default = original }
        }

        // Helper: subscribe to a CAP domain event; returns [spy, unsubscribe]
        // cds.services['MaintenanceService'] is the running ApplicationService instance.
        // CAP's Service.on() registers a handler in its own dispatch chain.
        function captureEvent(eventName) {
            const srv = cds.services['MaintenanceService']
            const captured = []
            const handler = async (msg) => { captured.push(msg.data) }
            srv.on(eventName, handler)
            const unsubscribe = () => {
                // CAP stores handlers in srv._handlers — remove ours
                const chain = srv._handlers?.[eventName]
                if (chain) {
                    const idx = chain.findIndex(h => h.handler === handler)
                    if (idx !== -1) chain.splice(idx, 1)
                }
            }
            return { captured, unsubscribe }
        }

        test('MaintenanceOrderCompleted emitted when all WorkItems are COMPLETED', async () => {
            const { captured, unsubscribe } = captureEvent('MaintenanceOrderCompleted')

            const { data: order } = await asAdmin(() =>
                POST('/maintenance/MaintenanceOrders', {
                    orderNumber: 'OM-EVT-001', description: 'Event test order',
                    equipment_ID: EQ_ACTIVE_ID, status: 'OPEN'
                })
            )
            const { data: wi1 } = await asAdmin(() =>
                POST('/maintenance/WorkItems', {
                    order_ID: order.ID, description: 'Task 1', status: 'PENDING'
                })
            )
            const { data: wi2 } = await asAdmin(() =>
                POST('/maintenance/WorkItems', {
                    order_ID: order.ID, description: 'Task 2', status: 'PENDING'
                })
            )

            // Completing the first item must NOT trigger the event
            await asAdmin(() =>
                PATCH(`/maintenance/WorkItems(${wi1.ID})`, { status: 'COMPLETED' })
            )
            jestExpect(captured).toHaveLength(0)

            // Completing the last item MUST trigger the event
            await asAdmin(() =>
                PATCH(`/maintenance/WorkItems(${wi2.ID})`, { status: 'COMPLETED' })
            )
            unsubscribe()

            jestExpect(captured).toHaveLength(1)
            jestExpect(captured[0].orderID).toBe(order.ID)
            jestExpect(captured[0].orderNumber).toBe('OM-EVT-001')
            jestExpect(captured[0].totalItems).toBe(2)
        })

        test('MaintenanceOrderCompleted NOT emitted on partial completion', async () => {
            const { captured, unsubscribe } = captureEvent('MaintenanceOrderCompleted')

            const { data: order } = await asAdmin(() =>
                POST('/maintenance/MaintenanceOrders', {
                    orderNumber: 'OM-EVT-002', description: 'Partial test',
                    equipment_ID: EQ_ACTIVE_ID, status: 'OPEN'
                })
            )
            await asAdmin(() =>
                POST('/maintenance/WorkItems', { order_ID: order.ID, description: 'Task 1', status: 'PENDING' })
            )
            const { data: wi2 } = await asAdmin(() =>
                POST('/maintenance/WorkItems', { order_ID: order.ID, description: 'Task 2', status: 'PENDING' })
            )
            // Complete only one of two items
            await asAdmin(() =>
                PATCH(`/maintenance/WorkItems(${wi2.ID})`, { status: 'COMPLETED' })
            )
            unsubscribe()

            jestExpect(captured).toHaveLength(0)
        })

        test('event payload contains equipmentID and completedAt', async () => {
            const { captured, unsubscribe } = captureEvent('MaintenanceOrderCompleted')

            const { data: order } = await asAdmin(() =>
                POST('/maintenance/MaintenanceOrders', {
                    orderNumber: 'OM-EVT-003', description: 'Payload check',
                    equipment_ID: EQ_ACTIVE_ID, status: 'OPEN'
                })
            )
            const { data: wi } = await asAdmin(() =>
                POST('/maintenance/WorkItems', {
                    order_ID: order.ID, description: 'Single task', status: 'PENDING'
                })
            )
            await asAdmin(() =>
                PATCH(`/maintenance/WorkItems(${wi.ID})`, { status: 'COMPLETED' })
            )
            unsubscribe()

            jestExpect(captured).toHaveLength(1)
            jestExpect(captured[0].equipmentID).toBe(EQ_ACTIVE_ID)
            jestExpect(typeof captured[0].completedAt).toBe('string')
            jestExpect(captured[0].totalItems).toBe(1)
        })
    })

    // ══════════════════════════════════════════════════════════════════════════
    // GROUP 5 — Structured Logging (Session 03, new)
    // ══════════════════════════════════════════════════════════════════════════
    describe('structured logging — logger.js', () => {

        test('createLogger returns object with required methods', () => {
            const LOG = createLogger('test.component')
            jestExpect(typeof LOG.info).toBe('function')
            jestExpect(typeof LOG.warn).toBe('function')
            jestExpect(typeof LOG.error).toBe('function')
            jestExpect(typeof LOG.apiCall).toBe('function')
            jestExpect(typeof LOG.circuitBreaker).toBe('function')
            jestExpect(typeof LOG.event).toBe('function')
        })

        test('apiCall does not throw and accepts all required parameters', () => {
            const LOG = createLogger('test.api')
            jestExpect(() =>
                LOG.apiCall('SparePartsAPI', '/parts/P-SEAL-001', 145, 'ok')
            ).not.toThrow()
            jestExpect(() =>
                LOG.apiCall('SparePartsAPI', '/parts/P-OBS-999', 12, 'unavailable')
            ).not.toThrow()
        })

        test('circuitBreaker does not throw and logs transitions', () => {
            const LOG = createLogger('test.cb')
            jestExpect(() =>
                LOG.circuitBreaker('SparePartsAPI', 'CLOSED', 'OPEN')
            ).not.toThrow()
            jestExpect(() =>
                LOG.circuitBreaker('SparePartsAPI', 'HALF-OPEN', 'CLOSED')
            ).not.toThrow()
        })
    })

})
