import { blocks } from 'bongle/starter';
import {
    addChild,
    addTrait,
    CharacterControllerTrait,
    cloneModel,
    ContactsTrait,
    createVoxelRaycastResult,
    destroyNode,
    env,
    ENVIRONMENT_OVERWORLD,
    findByName,
    findChildByName,
    getControlNode,
    getTrait,
    getVisualWorldPosition,
    isOwner,
    isKeyDown,
    model,
    type Node,
    onDispose,
    onFrame,
    onInit,
    onJoin,
    onLeave,
    onTick,
    onUpdate,
    pack,
    PlayerControllerTrait,
    raycastVoxels,
    removeTrait,
    RigidBodyTrait,
    script,
    setEnvironment,
    setPosition,
    setQuaternion,
    setWorldPosition,
    setWorldQuaternion,
    sync,
    trait,
    type TraitType,
    TransformTrait,
    use,
} from 'bongle';
import { rigidBody } from 'crashcat';
import { mat4, quat, type Quat, type Vec3, vec3 } from 'mathcat';

use(blocks);

const BallModel = model('ball', { src: 'assets/models/circus-ball.gltf' });

// ── tuning ────────────────────────────────────────────────────────────

const SPAWN: Vec3 = [0, 4, 0];
const BALL_RADIUS = 0.5;
const RESPAWN_Y = -20;

const LOOK_SENSITIVITY = 0.002;
// phi is polar from -Y (phi=0 down, phi=π up). clamp so the camera
// can't flip over the ball.
const PHI_MIN = 0.25;
const PHI_MAX = Math.PI - 0.25;

// dominantly torque-driven so the ball physically *rolls*; a small
// linear nudge gives WASD bite without long acceleration ramps.
// scaled for BALL_RADIUS=1.0 at default density 1000 (mass ≈ 4188kg,
// I ≈ 1675 kg·m²) — impulses are in kg·m/s, torques in kg·m²/s.
const ROLL_TORQUE = 1000;
// keep the linear nudge small on the ground so the ball mostly *rolls*
// instead of getting shoved. tuning floor: heavy enough that you feel the
// ball's inertia rather than puppet-string movement.
const LINEAR_NUDGE = 100;
const JUMP_IMPULSE_Y = 4200;
const MAX_HSPEED = 14;

const THIRD_PERSON_DISTANCE = 4.5;
const CAMERA_COLLISION_MARGIN = 0.2;
const EYE_HEIGHT = 1.62;
// procedural limb-swing tuning. no animation tracks — we directly write
// local rotations onto arm/leg bones each frame. phase advances at a
// rate proportional to horizontal ball speed; amplitude scales linearly
// up to STRIDE_FULL_SPEED so the character settles at rest.
const STRIDE_RATE_PER_MPS = 1.8;
const STRIDE_FULL_SPEED = 3.0;
// arms stay outstretched (balancing on the ball); only a small oscillation
// on top of the baseline so they don't look static.
const ARM_BASE_RAD = (75 * Math.PI) / 180;
const ARM_SWING_AMP_RAD = (8 * Math.PI) / 180;
// vertical-velocity reaction: falling raises the arms, jumping lowers them.
// linear in vy, clamped to ±ARM_VY_LIMIT_RAD so a fast fall doesn't push
// the arm past T-pose. the offset is exponentially smoothed toward the
// target so the motion reads visually instead of flickering with frame-to-
// frame vy noise.
const ARM_VY_GAIN_RAD_PER_MPS = 0.12;
const ARM_VY_LIMIT_RAD = (55 * Math.PI) / 180;
const ARM_VY_RESPONSE_RATE = 6;
const LEG_SWING_AMP_RAD = (40 * Math.PI) / 180;
// only re-aim facing yaw when ball is clearly moving — below this the
// horizontal-velocity direction is too noisy to follow.
const FACING_VELOCITY_THRESHOLD = 0.5;
// exponential-approach rate (1/s) for `_facingYaw` chasing the velocity-
// direction yaw — same shape CharacterController uses, just gentler so a
// rolling ball doesn't snap-turn when you swing the stick.
const FACING_YAW_RESPONSE_RATE = 8;

// head bone neck range. kept tight so that when the ball rolls toward the
// camera (body already facing camera) the head doesn't twist away — you
// want to see the character's face in that case.
const HEAD_YAW_LIMIT_RAD = (35 * Math.PI) / 180;
const HEAD_PITCH_LIMIT_RAD = (30 * Math.PI) / 180;

const ballName = (playerId: number): string => `ball:${playerId}`;

// ── BallControllerTrait ───────────────────────────────────────────────
//
// lives on the player node. owner-authority synced input + look. server +
// owner client both read the same input each tick and apply the same
// impulse on the (separate) ball rigid body, so prediction stays in sync.
// non-owner clients just read the replicated ball pose and visually follow.

export const BallControllerTrait = trait(
    'ball-controller',
    {
        // input — synced from owner. `look` matches mathcat Spherical layout
        // ([r, theta, phi]); r unused, theta is yaw, phi is polar from -Y.
        look: [0, 0, Math.PI / 2] as Vec3,
        // [strafe, forward] each in [-1, 1]
        move: [0, 0] as [number, number],
        jump: false,

        // runtime — non-synced (each side resolves locally)
        _ball: null as Node | null,
        _grounded: false,
        _prvJump: false,
        _currentCameraDistance: THIRD_PERSON_DISTANCE,
        // accumulated sine phase for procedural limb swing (rad). advances
        // each frame at a rate proportional to horizontal ball speed.
        _limbPhase: 0,
        // smoothed vertical-velocity arm offset (rad). lerps toward
        // clamp(-vy * gain) so the arm reaction is visible across the
        // duration of a jump/fall rather than tracking instantaneous vy.
        _armVyOffset: 0,
        // last facing yaw — held when velocity drops below threshold so
        // the character doesn't snap to a random direction at rest.
        _facingYaw: 0,
        // lazy init flag — first owner frame snaps `_facingYaw` to the
        // initial velocity-direction (or 0 if at rest) instead of slewing
        // from 0, which would visibly spin the rig on spawn.
        _facingYawInit: false,
    },
);

export type BallControllerTrait = TraitType<typeof BallControllerTrait>;

sync(BallControllerTrait, 'look', {
    schema: pack.list(pack.float32(), 2),
    pack: (t) => [t.look[1], t.look[2]],
    unpack: (v, t) => {
        t.look[1] = v[0]!;
        t.look[2] = v[1]!;
    },
    authority: 'owner',
});

sync(BallControllerTrait, 'move', {
    schema: pack.list(pack.float32(), 2),
    pack: (t) => t.move,
    unpack: (v, t) => {
        t.move[0] = v[0]!;
        t.move[1] = v[1]!;
    },
    authority: 'owner',
});

sync(BallControllerTrait, 'jump', {
    schema: pack.boolean(),
    pack: (t) => t.jump,
    unpack: (v, t) => {
        t.jump = v;
    },
    authority: 'owner',
});

// ── helpers ───────────────────────────────────────────────────────────

function ensureBall(t: BallControllerTrait, playerNode: Node): Node | null {
    if (t._ball?.parent) return t._ball;
    if (!playerNode.parent) return null;
    const owner = playerNode.owner;
    if (owner === null) return null;
    const ball = findChildByName(playerNode.parent, ballName(owner));
    if (ball) t._ball = ball;
    return t._ball;
}

// engine convention (mirrors player-controller updateCamera):
// theta=0, phi=π/2 → fwd = -Z.
function lookForward(out: Vec3, theta: number, phi: number): Vec3 {
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    out[0] = -st * sp;
    out[1] = -cp;
    out[2] = -ct * sp;
    return out;
}

function computeGrounded(ball: Node): boolean {
    const contacts = getTrait(ball, ContactsTrait);
    if (!contacts) return false;
    for (const c of contacts.active) {
        // ContactsTrait normals point AWAY from this node — a ball resting
        // on the floor sees a normal pointing down (−Y) into the ground.
        if (c.normal[1] < -0.6) return true;
    }
    return false;
}

// ── server: spawn ball on join, owner = player; respawn on fall ───────

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);

    onJoin(ctx, ({ playerNode }) => {
        const playerId = playerNode.owner;
        if (playerId === null) return;

        // teleport the engine-supplied player node to spawn; CharacterTrait
        // (auto-added by the engine) mounts the avatar visuals here.
        const pt = getTrait(playerNode, TransformTrait)!;
        setPosition(pt, [SPAWN[0], SPAWN[1] + BALL_RADIUS, SPAWN[2]]);

        // this game drives the player via BallControllerTrait, so drop the
        // engine's default humanoid controls (movement + input/camera).
        removeTrait(playerNode, CharacterControllerTrait);
        removeTrait(playerNode, PlayerControllerTrait);

        // ── ball ──
        // separate node, sibling under room root. owner = same player; the
        // ball is owner-client-authoritative (no prediction needed — the
        // owner *is* the source of truth).
        const ball = cloneModel(BallModel.scene);
        ball.name = ballName(playerId);
        ball.persist = false;
        ball.owner = playerId;

        const ballTransform = getTrait(ball, TransformTrait)!;
        setPosition(ballTransform, [SPAWN[0], SPAWN[1], SPAWN[2]]);

        addTrait(ball, RigidBodyTrait, {
            def: {
                shape: { type: 'sphere', radius: BALL_RADIUS },
                restitution: 0.2,
                friction: 1,
                maxLinearVelocity: 30,
                maxAngularVelocity: 12,
            },
            prediction: false,
        });

        addChild(ctx.nodes.root, ball);

        // ── controller ──
        // adds the input + camera + visual-follow trait to the player.
        // stash the ball ref here so onLeave can destroy it without a
        // name-based lookup. `_ball` is also (independently) populated
        // on each client by `ensureBall`.
        const controller = addTrait(playerNode, BallControllerTrait);
        controller._ball = ball;
    });

    // engine destroys the player node on leave, but the ball is a
    // sibling we created — own its teardown here.
    onLeave(ctx, ({ playerNode }) => {
        const controller = getTrait(playerNode, BallControllerTrait);
        if (controller?._ball) destroyNode(controller._ball);
    });
});

// ── owner-client respawn on fall ──────────────────────────────────────
// client-authoritative ball → respawn from the owner side too.

script(BallControllerTrait, 'respawn', (ctx) => {
    if (!env.client) return;

    onTick(ctx, () => {
        if (!isOwner(ctx, ctx.node)) return;
        const ball = ensureBall(ctx.trait, ctx.node);
        if (!ball) return;
        const bt = getTrait(ball, TransformTrait);
        if (!bt || bt.position[1] >= RESPAWN_Y) return;
        setPosition(bt, [SPAWN[0], SPAWN[1], SPAWN[2]]);
        const rb = getTrait(ball, RigidBodyTrait);
        if (rb) {
            vec3.zero(rb.linearVelocity);
            vec3.zero(rb.angularVelocity);
        }
    });
});

// ── client (owner only): poll input → write to synced look/move/jump ──
script(BallControllerTrait, 'input', (ctx) => {
    if (!env.client) return;

    const onCanvasClick = (): void => {
        if (!document.pointerLockElement) {
            ctx.client?.domElement.requestPointerLock();
        }
    };

    onInit(ctx, () => {
        if (!isOwner(ctx, ctx.node)) return;
        ctx.client?.domElement.addEventListener('click', onCanvasClick);
    });

    onDispose(ctx, () => {
        if (!isOwner(ctx, ctx.node)) return;
        ctx.client?.domElement.removeEventListener('click', onCanvasClick);
        if (document.pointerLockElement) document.exitPointerLock();
    });

    onUpdate(ctx, () => {
        if (getControlNode(ctx) !== ctx.node) return;
        const input = ctx.client?.input;
        if (!input) return;
        const mk = input.mouseKeyboard;
        const t = ctx.trait;

        // ── look: mouse delta when pointer-locked ──
        if (document.pointerLockElement) {
            t.look[1] -= mk._dx * LOOK_SENSITIVITY;
            t.look[2] -= mk._dy * LOOK_SENSITIVITY;
        }
        if (t.look[2] < PHI_MIN) t.look[2] = PHI_MIN;
        else if (t.look[2] > PHI_MAX) t.look[2] = PHI_MAX;

        // ── move: WASD ──
        const mx =
            (isKeyDown(mk, 'KeyA') || isKeyDown(mk, 'ArrowLeft') ? -1 : 0) +
            (isKeyDown(mk, 'KeyD') || isKeyDown(mk, 'ArrowRight') ? 1 : 0);
        const mz =
            (isKeyDown(mk, 'KeyW') || isKeyDown(mk, 'ArrowUp') ? 1 : 0) +
            (isKeyDown(mk, 'KeyS') || isKeyDown(mk, 'ArrowDown') ? -1 : 0);
        t.move[0] = Math.max(-1, Math.min(1, mx));
        t.move[1] = Math.max(-1, Math.min(1, mz));

        // ── jump (held) ──
        t.jump = isKeyDown(mk, 'Space');
    });
});

// ── owner-client simulator ────────────────────────────────────────────
//
// the ball is client-authoritative: only the owner client applies
// impulses and runs the sim. TransformTrait pose sync is owner-authority,
// so the resulting motion flows owner client → server → other clients.

const _impulse: Vec3 = [0, 0, 0];
const _torque: Vec3 = [0, 0, 0];

script(BallControllerTrait, 'simulate', (ctx) => {
    if (!env.client) return;

    onTick(ctx, () => {
        if (!isOwner(ctx, ctx.node)) return;
        const t = ctx.trait;

        const ball = ensureBall(t, ctx.node);
        if (!ball) return;
        const rb = getTrait(ball, RigidBodyTrait);
        if (!rb?.body) return;

        // grounded — computed from ContactsTrait fan-out.
        t._grounded = computeGrounded(ball);

        // build a horizontal move direction relative to camera yaw.
        const theta = t.look[1];
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        // forward (XZ projection of look-forward at phi=π/2) and right.
        const fwdX = -sinTheta;
        const fwdZ = -cosTheta;
        const rgtX = cosTheta;
        const rgtZ = -sinTheta;
        const dx = fwdX * t.move[1] + rgtX * t.move[0];
        const dz = fwdZ * t.move[1] + rgtZ * t.move[0];
        const dlen = Math.sqrt(dx * dx + dz * dz);

        const world = ctx.physics.rigid.world;

        if (dlen > 1e-3) {
            const nx = dx / dlen;
            const nz = dz / dlen;

            // angular impulse: τ = r × F, with r = -Y (gravity side of the
            // ball) and F along the move direction. cross(-Y, dir) gives
            // (nz, 0, -nx) → ball spins to roll forward.
            _torque[0] = nz * ROLL_TORQUE;
            _torque[1] = 0;
            _torque[2] = -nx * ROLL_TORQUE;
            rigidBody.addAngularImpulse(world, rb.body, _torque);

            // small linear nudge — only when grounded, so air control
            // stays minimal and the ball arcs ballistically.
            if (t._grounded) {
                _impulse[0] = nx * LINEAR_NUDGE;
                _impulse[1] = 0;
                _impulse[2] = nz * LINEAR_NUDGE;
                rigidBody.addImpulse(world, rb.body, _impulse);
            }
        }

        // clamp horizontal speed.
        const lv = rb.body.motionProperties.linearVelocity;
        const hspeed = Math.sqrt(lv[0] * lv[0] + lv[2] * lv[2]);
        if (hspeed > MAX_HSPEED) {
            const k = MAX_HSPEED / hspeed;
            lv[0] *= k;
            lv[2] *= k;
        }

        // jump on rising edge of `jump` AND grounded.
        const jumpEdge = t.jump && !t._prvJump;
        t._prvJump = t.jump;
        if (jumpEdge && t._grounded) {
            _impulse[0] = 0;
            _impulse[1] = JUMP_IMPULSE_Y;
            _impulse[2] = 0;
            rigidBody.addImpulse(world, rb.body, _impulse);
        }
    });
});

// ── owner-only visual follow ──────────────────────────────────────────
//
// the playerNode pose is owner-authoritative (TransformTrait), so only
// the owner writes it; sync propagates the result to server + other
// clients each tick.

const _q: Quat = [0, 0, 0, 1];
const _followPos: Vec3 = [0, 0, 0];
const AXIS_UP: Vec3 = [0, 1, 0];
const AXIS_RIGHT: Vec3 = [1, 0, 0];
const AXIS_FORWARD: Vec3 = [0, 0, 1];
const _qHeadYaw: Quat = [0, 0, 0, 1];
const _qHeadPitch: Quat = [0, 0, 0, 1];
const _qHead: Quat = [0, 0, 0, 1];
const _qLimb: Quat = [0, 0, 0, 1];

/** wrap an angle into [-π, π] so the shortest signed delta survives the
 *  ±π seam. game code can't import the engine's internal `wrapPi`. */
function wrapPi(a: number): number {
    const tau = Math.PI * 2;
    a %= tau;
    if (a > Math.PI) a -= tau;
    else if (a < -Math.PI) a += tau;
    return a;
}

/** extract yaw (rad) from a pure-Y-axis quaternion. body yaw is written as
 *  `setAxisAngle(UP, θ)` so q = (0, sin(θ/2), 0, cos(θ/2)). matches the
 *  CharacterTrait helper of the same name. */
function bodyYawFromQuat(q: Quat): number {
    return 2 * Math.atan2(q[1], q[3]);
}

script(BallControllerTrait, 'follow', (ctx) => {
    onFrame(ctx, ({ delta }) => {
        if (!isOwner(ctx, ctx.node)) return;
        const t = ctx.trait;
        const ball = ensureBall(t, ctx.node);
        if (!ball) return;
        const bt = getTrait(ball, TransformTrait);
        const pt = getTrait(ctx.node, TransformTrait);
        if (!bt || !pt) return;

        // read the ball's *interpolated* visual pose so the character
        // doesn't stair-step behind tick-snapped ball poses.
        const ballVisual = getVisualWorldPosition(bt);
        _followPos[0] = ballVisual[0];
        _followPos[1] = ballVisual[1] + (BALL_RADIUS / 2) + 0.2;
        _followPos[2] = ballVisual[2];
        setWorldPosition(pt, _followPos);

        // body yaw target: direction the ball is rolling in. hold the last
        // yaw when velocity drops below threshold so the character doesn't
        // snap to a random direction at rest.
        // engine convention: theta=0 → fwd = -Z, so θ = atan2(-vx, -vz).
        const rigidBody = getTrait(ball, RigidBodyTrait)!;
        const vx = rigidBody.linearVelocity[0];
        const vz = rigidBody.linearVelocity[2];
        const sp = Math.sqrt(vx * vx + vz * vz);
        if (sp > FACING_VELOCITY_THRESHOLD) {
            const targetYaw = Math.atan2(-vx, -vz);
            if (!t._facingYawInit) {
                // first frame with valid heading — snap rather than slew so
                // we don't visibly twist out of the spawn pose.
                t._facingYaw = targetYaw;
                t._facingYawInit = true;
            } else {
                // exponential approach toward target, short way round the
                // ±π seam. same shape CharacterController uses for body yaw.
                const slew = wrapPi(targetYaw - t._facingYaw);
                const k = 1 - Math.exp(-FACING_YAW_RESPONSE_RATE * delta);
                t._facingYaw = wrapPi(t._facingYaw + slew * k);
            }
        }

        quat.setAxisAngle(_q, AXIS_UP, t._facingYaw);
        setQuaternion(pt, _q);
    });
});

// ── every-side procedural limb swing + head orientation ──────────────
//
// runs on every client. no animation clips — we directly write local
// rotations onto the canonical `arm_left` / `arm_right` / `leg_left` /
// `leg_right` bones each frame. phase advances at a rate proportional
// to horizontal ball speed; amplitude scales in over a small window so
// the character settles to a neutral pose at rest.

function setBoneAngle(playerNode: Node, name: string, axis: Vec3, angle: number): void {
    const bone = findByName(playerNode, name);
    if (!bone) return;
    const bt = getTrait(bone, TransformTrait);
    if (!bt) return;
    quat.setAxisAngle(_qLimb, axis, angle);
    setQuaternion(bt, _qLimb);
}

script(BallControllerTrait, 'limbs', (ctx) => {
    if (!env.client) return;

    onFrame(ctx, ({ delta }) => {
        const t = ctx.trait;
        const ball = ensureBall(t, ctx.node);
        if (!ball) return;

        // head bone orientation — yaw + pitch toward the look direction, clamped
        // to a neck range. body yaw is the rolling-direction follow, so headYaw
        // is `look_yaw − body_yaw` (mirrors CharacterTrait.updateHeadOrientation).
        const pt = getTrait(ctx.node, TransformTrait);
        if (pt) {
            const head = findByName(ctx.node, 'head');
            const headTransform = head ? getTrait(head, TransformTrait) : null;
            if (headTransform) {
                const bodyYaw = bodyYawFromQuat(pt.quaternion);
                const rawHeadYaw = wrapPi(t.look[1] - bodyYaw);
                let headYaw = rawHeadYaw;
                if (headYaw > HEAD_YAW_LIMIT_RAD) headYaw = HEAD_YAW_LIMIT_RAD;
                else if (headYaw < -HEAD_YAW_LIMIT_RAD) headYaw = -HEAD_YAW_LIMIT_RAD;
                // look phi is polar from -Y (π/2 = level); pitch is the offset
                // from level, positive = look up. only apply pitch when the
                // body is facing roughly the same way as the camera (i.e. we're
                // looking at the character's back) — when rolling toward the
                // camera the head pitch reads awkwardly from the front, so
                // fade it out via cos(rawHeadYaw) clipped to the forward
                // hemisphere.
                const pitchFactor = Math.max(0, Math.cos(rawHeadYaw));
                let pitch = (t.look[2] - Math.PI / 2) * pitchFactor;
                if (pitch > HEAD_PITCH_LIMIT_RAD) pitch = HEAD_PITCH_LIMIT_RAD;
                else if (pitch < -HEAD_PITCH_LIMIT_RAD) pitch = -HEAD_PITCH_LIMIT_RAD;
                quat.setAxisAngle(_qHeadYaw, AXIS_UP, headYaw);
                quat.setAxisAngle(_qHeadPitch, AXIS_RIGHT, pitch);
                quat.multiply(_qHead, _qHeadYaw, _qHeadPitch);
                setQuaternion(headTransform, _qHead);
            }
        }

        // procedural limb swing — no clips. each side reads its own
        // local ball velocity (RigidBodyTrait.linearVelocity is synced),
        // accumulates phase, and writes bone rotations directly.
        const rb = getTrait(ball, RigidBodyTrait);
        if (!rb) return;
        const lv = rb.linearVelocity;
        const hspeed = Math.sqrt(lv[0] * lv[0] + lv[2] * lv[2]);

        t._limbPhase += delta * hspeed * STRIDE_RATE_PER_MPS;
        // wrap to keep the accumulator bounded.
        if (t._limbPhase > Math.PI * 2) t._limbPhase -= Math.PI * 2;
        else if (t._limbPhase < -Math.PI * 2) t._limbPhase += Math.PI * 2;

        const speedFactor = Math.min(hspeed / STRIDE_FULL_SPEED, 1);
        const s = Math.sin(t._limbPhase);

        // arms: Z rotation, mirrored L/R so they extend outward symmetrically.
        // a constant outward baseline + small sine oscillation — the character
        // is balancing on a ball, so arms-out is the natural pose. vertical
        // velocity adds a "panic" offset: falling raises the arms higher,
        // jumping pulls them down.
        let targetVyOffset = -lv[1] * ARM_VY_GAIN_RAD_PER_MPS;
        if (targetVyOffset > ARM_VY_LIMIT_RAD) targetVyOffset = ARM_VY_LIMIT_RAD;
        else if (targetVyOffset < -ARM_VY_LIMIT_RAD) targetVyOffset = -ARM_VY_LIMIT_RAD;
        const kVy = 1 - Math.exp(-ARM_VY_RESPONSE_RATE * delta);
        t._armVyOffset += (targetVyOffset - t._armVyOffset) * kVy;
        const armAngle = ARM_BASE_RAD + t._armVyOffset + ARM_SWING_AMP_RAD * speedFactor * s;
        setBoneAngle(ctx.node, 'arm_left', AXIS_FORWARD, -armAngle);
        setBoneAngle(ctx.node, 'arm_right', AXIS_FORWARD, +armAngle);

        // legs: X rotation, opposite phase L/R for an alternating step.
        const legAngle = LEG_SWING_AMP_RAD * speedFactor * s;
        setBoneAngle(ctx.node, 'leg_left', AXIS_RIGHT, +legAngle);
        setBoneAngle(ctx.node, 'leg_right', AXIS_RIGHT, -legAngle);
    });
});

// ── client (owner only): third-person camera with voxel raycast clamp ─

const _eye: Vec3 = [0, 0, 0];
const _target: Vec3 = [0, 0, 0];
const _fwd: Vec3 = [0, 0, 0];
const _lookMat = mat4.create();
const _camQuat: Quat = [0, 0, 0, 1];
const _voxelHit = createVoxelRaycastResult();

script(BallControllerTrait, 'camera', (ctx) => {
    if (!env.client) return;

    onFrame(ctx, () => {
        if (getControlNode(ctx) !== ctx.node) return;
        const t = ctx.trait;
        const ball = ensureBall(t, ctx.node);
        if (!ball) return;
        const bt = getTrait(ball, TransformTrait);
        if (!bt) return;

        const cameraNode = ctx.client!.camera;
        const cameraTransform = getTrait(cameraNode, TransformTrait);
        if (!cameraTransform) return;

        // head position above ball center. read the *visual* (interpolated)
        // pose so the camera follows smoothly between physics ticks.
        const ballVisual = getVisualWorldPosition(bt);
        const headX = ballVisual[0];
        const headY = ballVisual[1] + BALL_RADIUS + EYE_HEIGHT;
        const headZ = ballVisual[2];

        // look-forward from spherical.
        lookForward(_fwd, t.look[1], t.look[2]);

        // voxel raycast behind head along -fwd to clamp the orbit
        // distance when the camera would otherwise punch through terrain.
        // bodies are intentionally not raycast — the ball itself is the
        // most prominent body and we don't want it occluding its own POV.
        const voxels = ctx.voxels;
        raycastVoxels(
            _voxelHit,
            voxels,
            voxels.registry,
            headX,
            headY,
            headZ,
            -_fwd[0],
            -_fwd[1],
            -_fwd[2],
            THIRD_PERSON_DISTANCE,
            0,
        );
        const hitDist = _voxelHit.hit ? _voxelHit.distance : THIRD_PERSON_DISTANCE;
        const dist = Math.max(0, hitDist - CAMERA_COLLISION_MARGIN);
        t._currentCameraDistance = dist;

        _eye[0] = headX - _fwd[0] * dist;
        _eye[1] = headY - _fwd[1] * dist;
        _eye[2] = headZ - _fwd[2] * dist;
        _target[0] = headX;
        _target[1] = headY;
        _target[2] = headZ;

        setWorldPosition(cameraTransform, _eye);

        mat4.targetTo(_lookMat, _eye, _target, AXIS_UP);
        quat.fromMat4(_camQuat, _lookMat);
        setWorldQuaternion(cameraTransform, _camQuat);
    });
});
