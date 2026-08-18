// MOVEMENT TUNING
// One table, imported by the controller, the camera, the animation rig, the audio
// mixer and the level validator. Nothing re-derives these numbers locally, which is
// why the generator can never author a jump the controller cannot make.
export const MOVE = {
  gravity: 58,
  fallGravityMul: 1.22,          // heavier on the way down: reads as weight
  terminalFall: 92,

  runSpeed: 23,
  sprintSpeed: 36,
  boostSpeed: 58,
  hardCap: 78,                   // slopes and rails can exceed sprint, never this
  accel: 46,
  accelAir: 22,
  brakeDecel: 62,
  frictionDecel: 20,
  turnRate: 7.6,                 // radians/sec at low speed
  turnRateFast: 3.1,             // at hard cap: fast turns cost you
  airControl: 0.62,

  jumpSpeed: 25,
  doubleJumpSpeed: 21,
  coyoteTime: 0.11,
  jumpBuffer: 0.13,
  jumpCutMul: 0.46,              // releasing early shortens the arc

  groundDashSpeed: 52,
  groundDashTime: 0.26,
  airDashSpeed: 54,
  airDashTime: 0.22,
  airDashDistance: 13,
  dashCooldown: 0.34,
  airDashCharges: 1,

  homingRange: 34,
  homingSpeed: 74,
  homingBounce: 24,
  homingCone: 0.62,              // dot threshold in front of the camera

  slideSpeedMin: 16,
  slideBoost: 8,
  slideTime: 0.9,
  slideFriction: 5,

  wallRunMinSpeed: 18,
  wallRunTime: 1.5,
  wallRunGravity: 9,
  wallRunStick: 9,
  wallJumpOut: 24,
  wallJumpUp: 22,

  grindAccel: 7,
  grindMin: 16,
  grindMax: 70,

  slopeAccel: 46,                // downhill acceleration along the surface
  slopeBrake: 22,                // uphill cost
  slopeLaunchBoost: 1.14,        // leaving a downslope converts angle into arc

  groundPoundSpeed: 74,
  groundPoundRecover: 0.22,

  boostDrain: 34,                // boost meter units per second
  boostRegen: 13,
  boostMax: 100,
  boostAccel: 58,

  radius: 0.62,
  height: 1.86,
  stepUp: 0.9,

  hardLandingSpeed: 46,          // fall speed that triggers the heavy landing beat
  landRecover: 0.14,
  hardLandRecover: 0.34,

  maxHealth: 5,
  hitInvuln: 1.1,
  knockback: 22,
};

export const COMBAT = {
  comboWindow: 0.52,
  hitstopLight: 0.055,
  hitstopHeavy: 0.11,
  hitstopBoss: 0.14,
  meleeRange: 3.4,
  meleeArc: 0.55,
  dashAttackRange: 4.2,
  slamRadius: 9,
  chargeTime: 0.6,
  styleDecay: 3.2,
};
