/**
 * Adapted from Live2D/CubismWebFramework 5-r.5 at
 * 198a3769c26ca3d7b600e932590433badd392edd. The particle solver, integration,
 * output interpolation and normalization methods below retain the upstream
 * implementation. Pocket replaces only CubismJson/Core model access with
 * validated JSON objects and a JS-owned parameter-array adapter.
 */
/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismMath } from './math.ts';
import { CubismVector2 } from './vector2.ts';
import type { CubismPhysicsModel } from './physics-model.ts';
import {
  CubismPhysicsInput,
  CubismPhysicsNormalization,
  CubismPhysicsOutput,
  CubismPhysicsParticle,
  CubismPhysicsRig,
  CubismPhysicsSource,
  CubismPhysicsSubRig,
  CubismPhysicsTargetType
} from './physicsinternal.ts';
import { CubismManifestError } from '../manifest.ts';

// physics types tags.
const PhysicsTypeTagX = 'X';
const PhysicsTypeTagY = 'Y';
const PhysicsTypeTagAngle = 'Angle';

// Constant of air resistance.
const AirResistance = 5.0;

// Constant of maximum weight of input and output ratio.
const MaximumWeight = 100.0;

// Constant of threshold of movement.
const MovementThreshold = 0.001;

// Constant of maximum allowed delta time
const MaxDeltaTime = 5.0;

/**
 * 物理演算クラス
 */
export class CubismPhysics {
  /**
   * インスタンスの作成
   * @param buffer    physics3.jsonが読み込まれているバッファ
   * @param size      バッファのサイズ
   * @return 作成されたインスタンス
   */
  public static create(input: unknown): CubismPhysics {
    const ret: CubismPhysics = new CubismPhysics();

    ret.parse(input);
    ret._physicsRig.gravity.y = 0;

    return ret;
  }

  /**
   * インスタンスを破棄する
   * @param physics 破棄するインスタンス
   */
  public static delete(physics: CubismPhysics): void {
    if (physics != null) {
      physics.release();
    }
  }

  /**
   * physics3.jsonをパースする。
   * @param physicsJson physics3.jsonが読み込まれているバッファ
   * @param size バッファのサイズ
   */
  public parse(input: unknown): void {
    this._physicsRig = parsePhysicsRig(input);
    this._currentRigOutputs = this._physicsRig.settings.map((setting) => {
      const output = new PhysicsOutput();
      output.outputs = new Array<number>(setting.outputCount).fill(0);
      return output;
    });
    this._previousRigOutputs = this._physicsRig.settings.map((setting) => {
      const output = new PhysicsOutput();
      output.outputs = new Array<number>(setting.outputCount).fill(0);
      return output;
    });
    this.initialize();
  }

  /**
   * 現在のパラメータ値で物理演算が安定化する状態を演算する。
   * @param model 物理演算の結果を適用するモデル
   */
  public stabilization(model: CubismPhysicsModel): void {
    let totalAngle: { angle: number };
    let weight: number;
    let radAngle: number;
    let outputValue: number;
    const totalTranslation: CubismVector2 = new CubismVector2();
    let currentSetting: CubismPhysicsSubRig;
    let currentInputs: CubismPhysicsInput[];
    let currentOutputs: CubismPhysicsOutput[];
    let currentParticles: CubismPhysicsParticle[];

    const parameterValues: Float32Array = model.getModel().parameters.values;
    const parameterMaximumValues: Float32Array =
      model.getModel().parameters.maximumValues;
    const parameterMinimumValues: Float32Array =
      model.getModel().parameters.minimumValues;
    const parameterDefaultValues: Float32Array =
      model.getModel().parameters.defaultValues;

    if ((this._parameterCaches?.length ?? 0) < model.getParameterCount()) {
      this._parameterCaches = new Float32Array(model.getParameterCount());
    }

    if ((this._parameterInputCaches?.length ?? 0) < model.getParameterCount()) {
      this._parameterInputCaches = new Float32Array(model.getParameterCount());
    }

    for (let j = 0; j < model.getParameterCount(); ++j) {
      this._parameterCaches[j] = parameterValues[j];
      this._parameterInputCaches[j] = parameterValues[j];
    }

    for (
      let settingIndex = 0;
      settingIndex < this._physicsRig.subRigCount;
      ++settingIndex
    ) {
      totalAngle = { angle: 0.0 };
      totalTranslation.x = 0.0;
      totalTranslation.y = 0.0;
      currentSetting = this._physicsRig.settings[settingIndex];
      currentInputs = this._physicsRig.inputs.slice(
        currentSetting.baseInputIndex
      );
      currentOutputs = this._physicsRig.outputs.slice(
        currentSetting.baseOutputIndex
      );
      currentParticles = this._physicsRig.particles.slice(
        currentSetting.baseParticleIndex
      );

      // Load input parameters
      for (let i = 0; i < currentSetting.inputCount; ++i) {
        weight = currentInputs[i].weight / MaximumWeight;

        if (currentInputs[i].sourceParameterIndex == -1) {
          currentInputs[i].sourceParameterIndex = model.getParameterIndex(
            currentInputs[i].source.id
          );
        }

        currentInputs[i].getNormalizedParameterValue(
          totalTranslation,
          totalAngle,
          parameterValues[currentInputs[i].sourceParameterIndex],
          parameterMinimumValues[currentInputs[i].sourceParameterIndex],
          parameterMaximumValues[currentInputs[i].sourceParameterIndex],
          parameterDefaultValues[currentInputs[i].sourceParameterIndex],
          currentSetting.normalizationPosition,
          currentSetting.normalizationAngle,
          currentInputs[i].reflect,
          weight
        );

        this._parameterCaches[currentInputs[i].sourceParameterIndex] =
          parameterValues[currentInputs[i].sourceParameterIndex];
      }

      radAngle = CubismMath.degreesToRadian(-totalAngle.angle);

      totalTranslation.x =
        totalTranslation.x * CubismMath.cos(radAngle) -
        totalTranslation.y * CubismMath.sin(radAngle);
      totalTranslation.y =
        totalTranslation.x * CubismMath.sin(radAngle) +
        totalTranslation.y * CubismMath.cos(radAngle);

      // Calculate particles position.
      updateParticlesForStabilization(
        currentParticles,
        currentSetting.particleCount,
        totalTranslation,
        totalAngle.angle,
        this._options.wind,
        MovementThreshold * currentSetting.normalizationPosition.maximum
      );

      // Update output parameters.
      for (let i = 0; i < currentSetting.outputCount; ++i) {
        const particleIndex = currentOutputs[i].vertexIndex;

        if (currentOutputs[i].destinationParameterIndex == -1) {
          currentOutputs[i].destinationParameterIndex = model.getParameterIndex(
            currentOutputs[i].destination.id
          );
        }

        if (
          particleIndex < 1 ||
          particleIndex >= currentSetting.particleCount
        ) {
          continue;
        }

        let translation: CubismVector2 = new CubismVector2();
        translation = currentParticles[particleIndex].position.substract(
          currentParticles[particleIndex - 1].position
        );

        outputValue = currentOutputs[i].getValue(
          translation,
          currentParticles,
          particleIndex,
          currentOutputs[i].reflect,
          this._options.gravity
        );

        this._currentRigOutputs[settingIndex].outputs[i] = outputValue;
        this._previousRigOutputs[settingIndex].outputs[i] = outputValue;

        const destinationParameterIndex: number =
          currentOutputs[i].destinationParameterIndex;

        const outParameterCaches: Float32Array =
          !Float32Array.prototype.slice && 'subarray' in Float32Array.prototype
            ? JSON.parse(
                JSON.stringify(
                  parameterValues.subarray(destinationParameterIndex)
                )
              ) // 値渡しするため、JSON.parse, JSON.stringify
            : parameterValues.slice(destinationParameterIndex);

        updateOutputParameterValue(
          outParameterCaches,
          parameterMinimumValues[destinationParameterIndex],
          parameterMaximumValues[destinationParameterIndex],
          outputValue,
          currentOutputs[i]
        );

        // 値を反映
        for (
          let offset: number = destinationParameterIndex, outParamIndex = 0;
          offset < this._parameterCaches.length;
          offset++, outParamIndex++
        ) {
          parameterValues[offset] = this._parameterCaches[offset] =
            outParameterCaches[outParamIndex];
        }
      }
    }
  }

  /**
   * 物理演算の評価
   *
   * Pendulum interpolation weights
   *
   * 振り子の計算結果は保存され、パラメータへの出力は保存された前回の結果で補間されます。
   * The result of the pendulum calculation is saved and
   * the output to the parameters is interpolated with the saved previous result of the pendulum calculation.
   *
   * 図で示すと[1]と[2]で補間されます。
   * The figure shows the interpolation between [1] and [2].
   *
   * 補間の重みは最新の振り子計算タイミングと次回のタイミングの間で見た現在時間で決定する。
   * The weight of the interpolation are determined by the current time seen between
   * the latest pendulum calculation timing and the next timing.
   *
   * 図で示すと[2]と[4]の間でみた(3)の位置の重みになる。
   * Figure shows the weight of position (3) as seen between [2] and [4].
   *
   * 解釈として振り子計算のタイミングと重み計算のタイミングがズレる。
   * As an interpretation, the pendulum calculation and weights are misaligned.
   *
   * physics3.jsonにFPS情報が存在しない場合は常に前の振り子状態で設定される。
   * If there is no FPS information in physics3.json, it is always set in the previous pendulum state.
   *
   * この仕様は補間範囲を逸脱したことが原因の震えたような見た目を回避を目的にしている。
   * The purpose of this specification is to avoid the quivering appearance caused by deviations from the interpolation range.
   *
   * ------------ time -------------->
   *
   *                 |+++++|------| <- weight
   * ==[1]====#=====[2]---(3)----(4)
   *          ^ output contents
   *
   * 1:_previousRigOutputs
   * 2:_currentRigOutputs
   * 3:_currentRemainTime (now rendering)
   * 4:next particles timing
   * @param model 物理演算の結果を適用するモデル
   * @param deltaTimeSeconds デルタ時間[秒]
   */
  public evaluate(model: CubismPhysicsModel, deltaTimeSeconds: number): void {
    let totalAngle: { angle: number };
    let weight: number;
    let radAngle: number;
    let outputValue: number;
    const totalTranslation: CubismVector2 = new CubismVector2();
    let currentSetting: CubismPhysicsSubRig;
    let currentInputs: CubismPhysicsInput[];
    let currentOutputs: CubismPhysicsOutput[];
    let currentParticles: CubismPhysicsParticle[];

    if (0.0 >= deltaTimeSeconds) {
      return;
    }

    const parameterValues: Float32Array = model.getModel().parameters.values;
    const parameterMaximumValues: Float32Array =
      model.getModel().parameters.maximumValues;
    const parameterMinimumValues: Float32Array =
      model.getModel().parameters.minimumValues;
    const parameterDefaultValues: Float32Array =
      model.getModel().parameters.defaultValues;

    let physicsDeltaTime: number;
    this._currentRemainTime += deltaTimeSeconds;
    if (this._currentRemainTime > MaxDeltaTime) {
      this._currentRemainTime = 0.0;
    }

    if ((this._parameterCaches?.length ?? 0) < model.getParameterCount()) {
      this._parameterCaches = new Float32Array(model.getParameterCount());
    }

    if ((this._parameterInputCaches?.length ?? 0) < model.getParameterCount()) {
      this._parameterInputCaches = new Float32Array(model.getParameterCount());
      for (let j = 0; j < model.getParameterCount(); ++j) {
        this._parameterInputCaches[j] = parameterValues[j];
      }
    }

    if (this._physicsRig.fps > 0.0) {
      physicsDeltaTime = 1.0 / this._physicsRig.fps;
    } else {
      physicsDeltaTime = deltaTimeSeconds;
    }

    while (this._currentRemainTime >= physicsDeltaTime) {
      // copyRigOutputs _currentRigOutputs to _previousRigOutputs
      for (
        let settingIndex = 0;
        settingIndex < this._physicsRig.subRigCount;
        ++settingIndex
      ) {
        currentSetting = this._physicsRig.settings[settingIndex];
        currentOutputs = this._physicsRig.outputs.slice(
          currentSetting.baseOutputIndex
        );
        for (let i = 0; i < currentSetting.outputCount; ++i) {
          this._previousRigOutputs[settingIndex].outputs[i] =
            this._currentRigOutputs[settingIndex].outputs[i];
        }
      }

      // 入力キャッシュとパラメータで線形補間してUpdateParticlesするタイミングでの入力を計算する。
      // Calculate the input at the timing to UpdateParticles by linear interpolation with the _parameterInputCache and parameterValue.
      // _parameterCacheはグループ間での値の伝搬の役割があるので_parameterInputCacheとの分離が必要。
      // _parameterCache needs to be separated from _parameterInputCache because of its role in propagating values between groups.
      const inputWeight = physicsDeltaTime / this._currentRemainTime;
      for (let j = 0; j < model.getParameterCount(); ++j) {
        this._parameterCaches[j] =
          this._parameterInputCaches[j] * (1.0 - inputWeight) +
          parameterValues[j] * inputWeight;
        this._parameterInputCaches[j] = this._parameterCaches[j];
      }

      for (
        let settingIndex = 0;
        settingIndex < this._physicsRig.subRigCount;
        ++settingIndex
      ) {
        totalAngle = { angle: 0.0 };
        totalTranslation.x = 0.0;
        totalTranslation.y = 0.0;
        currentSetting = this._physicsRig.settings[settingIndex];
        currentInputs = this._physicsRig.inputs.slice(
          currentSetting.baseInputIndex
        );
        currentOutputs = this._physicsRig.outputs.slice(
          currentSetting.baseOutputIndex
        );
        currentParticles = this._physicsRig.particles.slice(
          currentSetting.baseParticleIndex
        );

        // Load input parameters
        for (let i = 0; i < currentSetting.inputCount; ++i) {
          weight = currentInputs[i].weight / MaximumWeight;

          if (currentInputs[i].sourceParameterIndex == -1) {
            currentInputs[i].sourceParameterIndex = model.getParameterIndex(
              currentInputs[i].source.id
            );
          }

          currentInputs[i].getNormalizedParameterValue(
            totalTranslation,
            totalAngle,
            this._parameterCaches[currentInputs[i].sourceParameterIndex],
            parameterMinimumValues[currentInputs[i].sourceParameterIndex],
            parameterMaximumValues[currentInputs[i].sourceParameterIndex],
            parameterDefaultValues[currentInputs[i].sourceParameterIndex],
            currentSetting.normalizationPosition,
            currentSetting.normalizationAngle,
            currentInputs[i].reflect,
            weight
          );
        }

        radAngle = CubismMath.degreesToRadian(-totalAngle.angle);

        totalTranslation.x =
          totalTranslation.x * CubismMath.cos(radAngle) -
          totalTranslation.y * CubismMath.sin(radAngle);
        totalTranslation.y =
          totalTranslation.x * CubismMath.sin(radAngle) +
          totalTranslation.y * CubismMath.cos(radAngle);

        // Calculate particles position.
        updateParticles(
          currentParticles,
          currentSetting.particleCount,
          totalTranslation,
          totalAngle.angle,
          this._options.wind,
          MovementThreshold * currentSetting.normalizationPosition.maximum,
          physicsDeltaTime,
          AirResistance
        );

        // Update output parameters.
        for (let i = 0; i < currentSetting.outputCount; ++i) {
          const particleIndex = currentOutputs[i].vertexIndex;

          if (currentOutputs[i].destinationParameterIndex == -1) {
            currentOutputs[i].destinationParameterIndex =
              model.getParameterIndex(currentOutputs[i].destination.id);
          }

          if (
            particleIndex < 1 ||
            particleIndex >= currentSetting.particleCount
          ) {
            continue;
          }

          const translation: CubismVector2 = new CubismVector2();
          translation.x =
            currentParticles[particleIndex]!.position.x -
            currentParticles[particleIndex - 1]!.position.x;
          translation.y =
            currentParticles[particleIndex]!.position.y -
            currentParticles[particleIndex - 1]!.position.y;

          outputValue = currentOutputs[i].getValue(
            translation,
            currentParticles,
            particleIndex,
            currentOutputs[i].reflect,
            this._options.gravity
          );

          this._currentRigOutputs[settingIndex].outputs[i] = outputValue;

          const destinationParameterIndex: number =
            currentOutputs[i].destinationParameterIndex;
          const outParameterCaches: Float32Array =
            !Float32Array.prototype.slice &&
            'subarray' in Float32Array.prototype
              ? JSON.parse(
                  JSON.stringify(
                    this._parameterCaches.subarray(destinationParameterIndex)
                  )
                ) // 値渡しするため、JSON.parse, JSON.stringify
              : this._parameterCaches.slice(destinationParameterIndex);

          updateOutputParameterValue(
            outParameterCaches,
            parameterMinimumValues[destinationParameterIndex],
            parameterMaximumValues[destinationParameterIndex],
            outputValue,
            currentOutputs[i]
          );

          // 値を反映
          for (
            let offset: number = destinationParameterIndex, outParamIndex = 0;
            offset < this._parameterCaches.length;
            offset++, outParamIndex++
          ) {
            this._parameterCaches[offset] = outParameterCaches[outParamIndex];
          }
        }
      }
      this._currentRemainTime -= physicsDeltaTime;
    }

    const alpha: number = this._currentRemainTime / physicsDeltaTime;
    this.interpolate(model, alpha);
  }

  /**
   * 物理演算結果の適用
   * 振り子演算の最新の結果と一つ前の結果から指定した重みで適用する。
   * @param model 物理演算の結果を適用するモデル
   * @param weight 最新結果の重み
   */
  public interpolate(model: CubismPhysicsModel, weight: number): void {
    let currentOutputs: CubismPhysicsOutput[];
    let currentSetting: CubismPhysicsSubRig;
    const parameterValues: Float32Array = model.getModel().parameters.values;
    const parameterMaximumValues: Float32Array =
      model.getModel().parameters.maximumValues;
    const parameterMinimumValues: Float32Array =
      model.getModel().parameters.minimumValues;

    for (
      let settingIndex = 0;
      settingIndex < this._physicsRig.subRigCount;
      ++settingIndex
    ) {
      currentSetting = this._physicsRig.settings[settingIndex];
      currentOutputs = this._physicsRig.outputs.slice(
        currentSetting.baseOutputIndex
      );

      // Load input parameters.
      for (let i = 0; i < currentSetting.outputCount; ++i) {
        if (currentOutputs[i].destinationParameterIndex == -1) {
          continue;
        }

        const destinationParameterIndex: number =
          currentOutputs[i].destinationParameterIndex;
        const outParameterValues: Float32Array =
          !Float32Array.prototype.slice && 'subarray' in Float32Array.prototype
            ? JSON.parse(
                JSON.stringify(
                  parameterValues.subarray(destinationParameterIndex)
                )
              ) // 値渡しするため、JSON.parse, JSON.stringify
            : parameterValues.slice(destinationParameterIndex);

        updateOutputParameterValue(
          outParameterValues,
          parameterMinimumValues[destinationParameterIndex],
          parameterMaximumValues[destinationParameterIndex],
          this._previousRigOutputs[settingIndex].outputs[i] * (1 - weight) +
            this._currentRigOutputs[settingIndex].outputs[i] * weight,
          currentOutputs[i]
        );

        // 値を反映
        for (
          let offset: number = destinationParameterIndex, outParamIndex = 0;
          offset < parameterValues.length;
          offset++, outParamIndex++
        ) {
          parameterValues[offset] = outParameterValues[outParamIndex];
        }
      }
    }
  }

  /**
   * オプションの設定
   * @param options オプション
   */
  public setOptions(options: Options): void {
    this._options = options;
  }

  /**
   * オプションの取得
   * @return オプション
   */
  public getOption(): Options {
    return this._options;
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    this._physicsRig = new CubismPhysicsRig();

    // set default options
    this._options = new Options();
    this._options.gravity.y = -1.0;
    this._options.gravity.x = 0.0;
    this._options.wind.x = 0.0;
    this._options.wind.y = 0.0;
    this._currentRigOutputs = new Array<PhysicsOutput>();
    this._previousRigOutputs = new Array<PhysicsOutput>();
    this._currentRemainTime = 0.0;
    this._parameterCaches = new Float32Array(0);
    this._parameterInputCaches = new Float32Array(0);
  }

  /**
   * デストラクタ相当の処理
   */
  public release(): void {
    this._physicsRig = new CubismPhysicsRig();
    this._currentRigOutputs = [];
    this._previousRigOutputs = [];
    this._parameterCaches = new Float32Array(0);
    this._parameterInputCaches = new Float32Array(0);
  }

  /**
   * 初期化する
   */
  public initialize(): void {
    let strand: CubismPhysicsParticle[];
    let currentSetting: CubismPhysicsSubRig;
    let radius: CubismVector2;

    for (
      let settingIndex = 0;
      settingIndex < this._physicsRig.subRigCount;
      ++settingIndex
    ) {
      currentSetting = this._physicsRig.settings[settingIndex];
      strand = this._physicsRig.particles.slice(
        currentSetting.baseParticleIndex
      );

      // Initialize the top of particle.
      strand[0]!.initialPosition = new CubismVector2(0.0, 0.0);
      strand[0]!.lastPosition = new CubismVector2(
        strand[0]!.initialPosition.x,
        strand[0]!.initialPosition.y
      );
      strand[0]!.lastGravity = new CubismVector2(0.0, -1.0);
      strand[0]!.lastGravity.y *= -1.0;
      strand[0]!.velocity = new CubismVector2(0.0, 0.0);
      strand[0]!.force = new CubismVector2(0.0, 0.0);

      // Initialize particles.
      for (let i = 1; i < currentSetting.particleCount; ++i) {
        radius = new CubismVector2(0.0, 0.0);
        radius.y = strand[i]!.radius;
        strand[i]!.initialPosition = new CubismVector2(
          strand[i - 1]!.initialPosition.x + radius.x,
          strand[i - 1]!.initialPosition.y + radius.y
        );
        strand[i]!.position = new CubismVector2(
          strand[i]!.initialPosition.x,
          strand[i]!.initialPosition.y
        );
        strand[i]!.lastPosition = new CubismVector2(
          strand[i]!.initialPosition.x,
          strand[i]!.initialPosition.y
        );
        strand[i]!.lastGravity = new CubismVector2(0.0, -1.0);
        strand[i]!.lastGravity.y *= -1.0;
        strand[i]!.velocity = new CubismVector2(0.0, 0.0);
        strand[i]!.force = new CubismVector2(0.0, 0.0);
      }
    }
  }

  _physicsRig: CubismPhysicsRig; // 物理演算のデータ
  _options: Options; // オプション

  _currentRigOutputs: Array<PhysicsOutput>; ///< 最新の振り子計算の結果
  _previousRigOutputs: Array<PhysicsOutput>; ///< 一つ前の振り子計算の結果

  _currentRemainTime: number; ///< 物理演算が処理していない時間

  _parameterCaches: Float32Array; ///< Evaluateで利用するパラメータのキャッシュ
  _parameterInputCaches: Float32Array; ///< UpdateParticlesが動くときの入力をキャッシュ
}

/**
 * 物理演算のオプション
 */
export class Options {
  constructor() {
    this.gravity = new CubismVector2(0, 0);
    this.wind = new CubismVector2(0, 0);
  }

  gravity: CubismVector2; // 重力方向
  wind: CubismVector2; // 風の方向
}

/**
 * パラメータに適用する前の物理演算の出力結果
 */
export class PhysicsOutput {
  constructor() {
    this.outputs = new Array<number>(0);
  }

  outputs: Array<number>; // 物理演算出力結果
}

/**
 * Gets sign.
 *
 * @param value Evaluation target value.
 *
 * @return Sign of value.
 */
function sign(value: number): number {
  let ret = 0;

  if (value > 0.0) {
    ret = 1;
  } else if (value < 0.0) {
    ret = -1;
  }

  return ret;
}

function getInputTranslationXFromNormalizedParameterValue(
  targetTranslation: CubismVector2,
  targetAngle: { angle: number },
  value: number,
  parameterMinimumValue: number,
  parameterMaximumValue: number,
  parameterDefaultValue: number,
  normalizationPosition: CubismPhysicsNormalization,
  normalizationAngle: CubismPhysicsNormalization,
  isInverted: boolean,
  weight: number
): void {
  targetTranslation.x +=
    normalizeParameterValue(
      value,
      parameterMinimumValue,
      parameterMaximumValue,
      parameterDefaultValue,
      normalizationPosition.minimum,
      normalizationPosition.maximum,
      normalizationPosition.defalut,
      isInverted
    ) * weight;
}

function getInputTranslationYFromNormalizedParamterValue(
  targetTranslation: CubismVector2,
  targetAngle: { angle: number },
  value: number,
  parameterMinimumValue: number,
  parameterMaximumValue: number,
  parameterDefaultValue: number,
  normalizationPosition: CubismPhysicsNormalization,
  normalizationAngle: CubismPhysicsNormalization,
  isInverted: boolean,
  weight: number
): void {
  targetTranslation.y +=
    normalizeParameterValue(
      value,
      parameterMinimumValue,
      parameterMaximumValue,
      parameterDefaultValue,
      normalizationPosition.minimum,
      normalizationPosition.maximum,
      normalizationPosition.defalut,
      isInverted
    ) * weight;
}

function getInputAngleFromNormalizedParameterValue(
  targetTranslation: CubismVector2,
  targetAngle: { angle: number },
  value: number,
  parameterMinimumValue: number,
  parameterMaximumValue: number,
  parameterDefaultValue: number,
  normalizaitionPosition: CubismPhysicsNormalization,
  normalizationAngle: CubismPhysicsNormalization,
  isInverted: boolean,
  weight: number
): void {
  targetAngle.angle +=
    normalizeParameterValue(
      value,
      parameterMinimumValue,
      parameterMaximumValue,
      parameterDefaultValue,
      normalizationAngle.minimum,
      normalizationAngle.maximum,
      normalizationAngle.defalut,
      isInverted
    ) * weight;
}

function getOutputTranslationX(
  translation: CubismVector2,
  particles: CubismPhysicsParticle[],
  particleIndex: number,
  isInverted: boolean,
  parentGravity: CubismVector2
): number {
  let outputValue: number = translation.x;

  if (isInverted) {
    outputValue *= -1.0;
  }

  return outputValue;
}

function getOutputTranslationY(
  translation: CubismVector2,
  particles: CubismPhysicsParticle[],
  particleIndex: number,
  isInverted: boolean,
  parentGravity: CubismVector2
): number {
  let outputValue: number = translation.y;

  if (isInverted) {
    outputValue *= -1.0;
  }
  return outputValue;
}

function getOutputAngle(
  translation: CubismVector2,
  particles: CubismPhysicsParticle[],
  particleIndex: number,
  isInverted: boolean,
  parentGravity: CubismVector2
): number {
  let outputValue: number;

  if (particleIndex >= 2) {
    parentGravity = particles[particleIndex - 1].position.substract(
      particles[particleIndex - 2].position
    );
  } else {
    parentGravity = parentGravity.multiplyByScaler(-1.0);
  }

  outputValue = CubismMath.directionToRadian(parentGravity, translation);

  if (isInverted) {
    outputValue *= -1.0;
  }

  return outputValue;
}

function getRangeValue(min: number, max: number): number {
  const maxValue: number = CubismMath.max(min, max);
  const minValue: number = CubismMath.min(min, max);

  return CubismMath.abs(maxValue - minValue);
}

function getDefaultValue(min: number, max: number): number {
  const minValue: number = CubismMath.min(min, max);
  return minValue + getRangeValue(min, max) / 2.0;
}

function getOutputScaleTranslationX(
  translationScale: CubismVector2,
  angleScale: number
): number {
  return JSON.parse(JSON.stringify(translationScale.x));
}

function getOutputScaleTranslationY(
  translationScale: CubismVector2,
  angleScale: number
): number {
  return JSON.parse(JSON.stringify(translationScale.y));
}

function getOutputScaleAngle(
  translationScale: CubismVector2,
  angleScale: number
): number {
  return JSON.parse(JSON.stringify(angleScale));
}

/**
 * Updates particles.
 *
 * @param strand                Target array of particle.
 * @param strandCount           Count of particle.
 * @param totalTranslation      Total translation value.
 * @param totalAngle            Total angle.
 * @param windDirection         Direction of Wind.
 * @param thresholdValue        Threshold of movement.
 * @param deltaTimeSeconds      Delta time.
 * @param airResistance         Air resistance.
 */
function updateParticles(
  strand: CubismPhysicsParticle[],
  strandCount: number,
  totalTranslation: CubismVector2,
  totalAngle: number,
  windDirection: CubismVector2,
  thresholdValue: number,
  deltaTimeSeconds: number,
  airResistance: number
) {
  let delay: number;
  let radian: number;
  let direction: CubismVector2 = new CubismVector2(0.0, 0.0);
  let velocity: CubismVector2 = new CubismVector2(0.0, 0.0);
  let force: CubismVector2 = new CubismVector2(0.0, 0.0);
  let newDirection: CubismVector2 = new CubismVector2(0.0, 0.0);

  strand[0].position = new CubismVector2(
    totalTranslation.x,
    totalTranslation.y
  );

  const totalRadian: number = CubismMath.degreesToRadian(totalAngle);
  const currentGravity: CubismVector2 =
    CubismMath.radianToDirection(totalRadian);
  currentGravity.normalize();

  for (let i = 1; i < strandCount; ++i) {
    strand[i].force = currentGravity
      .multiplyByScaler(strand[i].acceleration)
      .add(windDirection);

    strand[i].lastPosition = new CubismVector2(
      strand[i].position.x,
      strand[i].position.y
    );

    delay = strand[i].delay * deltaTimeSeconds * 30.0;

    direction = strand[i].position.substract(strand[i - 1].position);

    radian =
      CubismMath.directionToRadian(strand[i].lastGravity, currentGravity) /
      airResistance;

    direction.x =
      CubismMath.cos(radian) * direction.x -
      direction.y * CubismMath.sin(radian);
    direction.y =
      CubismMath.sin(radian) * direction.x +
      direction.y * CubismMath.cos(radian);

    strand[i].position = strand[i - 1].position.add(direction);

    velocity = strand[i].velocity.multiplyByScaler(delay);
    force = strand[i].force.multiplyByScaler(delay).multiplyByScaler(delay);

    strand[i].position = strand[i].position.add(velocity).add(force);

    newDirection = strand[i].position.substract(strand[i - 1].position);
    newDirection.normalize();

    strand[i].position = strand[i - 1].position.add(
      newDirection.multiplyByScaler(strand[i].radius)
    );

    if (CubismMath.abs(strand[i].position.x) < thresholdValue) {
      strand[i].position.x = 0.0;
    }

    if (delay != 0.0) {
      strand[i].velocity = strand[i].position.substract(strand[i].lastPosition);
      strand[i].velocity = strand[i].velocity.divisionByScalar(delay);
      strand[i].velocity = strand[i].velocity.multiplyByScaler(
        strand[i].mobility
      );
    }

    strand[i].force = new CubismVector2(0.0, 0.0);
    strand[i].lastGravity = new CubismVector2(
      currentGravity.x,
      currentGravity.y
    );
  }
}

/**
 * Updates particles for stabilization.
 *
 * @param strand                Target array of particle.
 * @param strandCount           Count of particle.
 * @param totalTranslation      Total translation value.
 * @param totalAngle            Total angle.
 * @param windDirection         Direction of Wind.
 * @param thresholdValue        Threshold of movement.
 */
function updateParticlesForStabilization(
  strand: CubismPhysicsParticle[],
  strandCount: number,
  totalTranslation: CubismVector2,
  totalAngle: number,
  windDirection: CubismVector2,
  thresholdValue: number
) {
  let force: CubismVector2 = new CubismVector2(0.0, 0.0);

  strand[0].position = new CubismVector2(
    totalTranslation.x,
    totalTranslation.y
  );

  const totalRadian: number = CubismMath.degreesToRadian(totalAngle);
  const currentGravity: CubismVector2 =
    CubismMath.radianToDirection(totalRadian);
  currentGravity.normalize();

  for (let i = 1; i < strandCount; ++i) {
    strand[i].force = currentGravity
      .multiplyByScaler(strand[i].acceleration)
      .add(windDirection);

    strand[i].lastPosition = new CubismVector2(
      strand[i].position.x,
      strand[i].position.y
    );

    strand[i].velocity = new CubismVector2(0.0, 0.0);
    force = strand[i].force;
    force.normalize();

    force = force.multiplyByScaler(strand[i].radius);
    strand[i].position = strand[i - 1].position.add(force);

    if (CubismMath.abs(strand[i].position.x) < thresholdValue) {
      strand[i].position.x = 0.0;
    }

    strand[i].force = new CubismVector2(0.0, 0.0);
    strand[i].lastGravity = new CubismVector2(
      currentGravity.x,
      currentGravity.y
    );
  }
}

/**
 * Updates output parameter value.
 * @param parameterValue            Target parameter value.
 * @param parameterValueMinimum     Minimum of parameter value.
 * @param parameterValueMaximum     Maximum of parameter value.
 * @param translation               Translation value.
 */
function updateOutputParameterValue(
  parameterValue: Float32Array,
  parameterValueMinimum: number,
  parameterValueMaximum: number,
  translation: number,
  output: CubismPhysicsOutput
): void {
  let value: number;
  const outputScale: number = output.getScale(
    output.translationScale,
    output.angleScale
  );

  value = translation * outputScale;

  if (value < parameterValueMinimum) {
    if (value < output.valueBelowMinimum) {
      output.valueBelowMinimum = value;
    }

    value = parameterValueMinimum;
  } else if (value > parameterValueMaximum) {
    if (value > output.valueExceededMaximum) {
      output.valueExceededMaximum = value;
    }

    value = parameterValueMaximum;
  }

  const weight: number = output.weight / MaximumWeight;

  if (weight >= 1.0) {
    parameterValue[0] = value;
  } else {
    value = parameterValue[0] * (1.0 - weight) + value * weight;
    parameterValue[0] = value;
  }
}

function normalizeParameterValue(
  value: number,
  parameterMinimum: number,
  parameterMaximum: number,
  parameterDefault: number,
  normalizedMinimum: number,
  normalizedMaximum: number,
  normalizedDefault: number,
  isInverted: boolean
) {
  let result = 0.0;

  const maxValue: number = CubismMath.max(parameterMaximum, parameterMinimum);

  if (maxValue < value) {
    value = maxValue;
  }

  const minValue: number = CubismMath.min(parameterMaximum, parameterMinimum);

  if (minValue > value) {
    value = minValue;
  }

  const minNormValue: number = CubismMath.min(
    normalizedMinimum,
    normalizedMaximum
  );
  const maxNormValue: number = CubismMath.max(
    normalizedMinimum,
    normalizedMaximum
  );
  const middleNormValue: number = normalizedDefault;

  const middleValue: number = getDefaultValue(minValue, maxValue);
  const paramValue: number = value - middleValue;

  switch (sign(paramValue)) {
    case 1: {
      const nLength: number = maxNormValue - middleNormValue;
      const pLength: number = maxValue - middleValue;

      if (pLength != 0.0) {
        result = paramValue * (nLength / pLength);
        result += middleNormValue;
      }

      break;
    }
    case -1: {
      const nLength: number = minNormValue - middleNormValue;
      const pLength: number = minValue - middleValue;

      if (pLength != 0.0) {
        result = paramValue * (nLength / pLength);
        result += middleNormValue;
      }

      break;
    }
    case 0: {
      result = middleNormValue;

      break;
    }
    default: {
      break;
    }
  }

  return isInverted ? result : result * -1.0;
}

function parsePhysicsRig(input: unknown): CubismPhysicsRig {
  const root = object(typeof input === "string" ? parseJson(input) : input, "physics3");
  if (root.Version !== 3) throw new CubismManifestError("physics3.Version must be 3");
  const meta = object(root.Meta, "physics3.Meta");
  const forces = object(meta.EffectiveForces, "physics3.Meta.EffectiveForces");
  const gravity = vector(forces.Gravity, "physics3.Meta.EffectiveForces.Gravity");
  const wind = vector(forces.Wind, "physics3.Meta.EffectiveForces.Wind");
  const settingsValue = root.PhysicsSettings;
  if (!Array.isArray(settingsValue)) throw new CubismManifestError("physics3.PhysicsSettings must be an array");

  const rig = new CubismPhysicsRig();
  rig.gravity = new CubismVector2(gravity.x, gravity.y);
  rig.wind = new CubismVector2(wind.x, wind.y);
  rig.subRigCount = settingsValue.length;
  rig.fps = meta.Fps === undefined ? 0 : nonNegativeNumber(meta.Fps, "physics3.Meta.Fps");

  let inputIndex = 0;
  let outputIndex = 0;
  let particleIndex = 0;
  for (let settingIndex = 0; settingIndex < settingsValue.length; settingIndex++) {
    const path = `physics3.PhysicsSettings[${settingIndex}]`;
    const settingJson = object(settingsValue[settingIndex], path);
    const setting = new CubismPhysicsSubRig();
    setting.baseInputIndex = inputIndex;
    setting.baseOutputIndex = outputIndex;
    setting.baseParticleIndex = particleIndex;
    setting.normalizationPosition = normalization(settingJson.Normalization, "Position", `${path}.Normalization.Position`);
    setting.normalizationAngle = normalization(settingJson.Normalization, "Angle", `${path}.Normalization.Angle`);

    const inputs = array(settingJson.Input, `${path}.Input`);
    setting.inputCount = inputs.length;
    for (let index = 0; index < inputs.length; index++) {
      const inputPath = `${path}.Input[${index}]`;
      const entry = object(inputs[index], inputPath);
      const source = object(entry.Source, `${inputPath}.Source`);
      if (source.Target !== "Parameter") throw new CubismManifestError(`${inputPath}.Source.Target must be Parameter`);
      const type = physicsSource(entry.Type, `${inputPath}.Type`);
      const physicsInput = new CubismPhysicsInput();
      physicsInput.sourceParameterIndex = -1;
      physicsInput.source.targetType = CubismPhysicsTargetType.CubismPhysicsTargetType_Parameter;
      physicsInput.source.id = nonEmptyString(source.Id, `${inputPath}.Source.Id`);
      physicsInput.weight = finite(entry.Weight, `${inputPath}.Weight`);
      physicsInput.reflect = boolean(entry.Reflect, `${inputPath}.Reflect`);
      physicsInput.type = type;
      physicsInput.getNormalizedParameterValue = type === CubismPhysicsSource.CubismPhysicsSource_X
        ? getInputTranslationXFromNormalizedParameterValue
        : type === CubismPhysicsSource.CubismPhysicsSource_Y
          ? getInputTranslationYFromNormalizedParamterValue
          : getInputAngleFromNormalizedParameterValue;
      rig.inputs.push(physicsInput);
    }

    const outputs = array(settingJson.Output, `${path}.Output`);
    setting.outputCount = outputs.length;
    for (let index = 0; index < outputs.length; index++) {
      const outputPath = `${path}.Output[${index}]`;
      const entry = object(outputs[index], outputPath);
      const destination = object(entry.Destination, `${outputPath}.Destination`);
      if (destination.Target !== "Parameter") throw new CubismManifestError(`${outputPath}.Destination.Target must be Parameter`);
      const type = physicsSource(entry.Type, `${outputPath}.Type`);
      const output = new CubismPhysicsOutput();
      output.destinationParameterIndex = -1;
      output.destination.targetType = CubismPhysicsTargetType.CubismPhysicsTargetType_Parameter;
      output.destination.id = nonEmptyString(destination.Id, `${outputPath}.Destination.Id`);
      output.vertexIndex = integer(entry.VertexIndex, `${outputPath}.VertexIndex`);
      output.angleScale = finite(entry.Scale, `${outputPath}.Scale`);
      output.weight = finite(entry.Weight, `${outputPath}.Weight`);
      output.reflect = boolean(entry.Reflect, `${outputPath}.Reflect`);
      output.type = type;
      output.getValue = type === CubismPhysicsSource.CubismPhysicsSource_X
        ? getOutputTranslationX
        : type === CubismPhysicsSource.CubismPhysicsSource_Y
          ? getOutputTranslationY
          : getOutputAngle;
      output.getScale = type === CubismPhysicsSource.CubismPhysicsSource_X
        ? getOutputScaleTranslationX
        : type === CubismPhysicsSource.CubismPhysicsSource_Y
          ? getOutputScaleTranslationY
          : getOutputScaleAngle;
      rig.outputs.push(output);
    }

    const vertices = array(settingJson.Vertices, `${path}.Vertices`);
    if (vertices.length === 0) throw new CubismManifestError(`${path}.Vertices must contain the root particle`);
    setting.particleCount = vertices.length;
    for (let index = 0; index < vertices.length; index++) {
      const vertexPath = `${path}.Vertices[${index}]`;
      const entry = object(vertices[index], vertexPath);
      const position = vector(entry.Position, `${vertexPath}.Position`);
      const particle = new CubismPhysicsParticle();
      particle.position = new CubismVector2(position.x, position.y);
      particle.mobility = nonNegativeNumber(entry.Mobility, `${vertexPath}.Mobility`);
      particle.delay = nonNegativeNumber(entry.Delay, `${vertexPath}.Delay`);
      particle.acceleration = nonNegativeNumber(entry.Acceleration, `${vertexPath}.Acceleration`);
      particle.radius = nonNegativeNumber(entry.Radius, `${vertexPath}.Radius`);
      rig.particles.push(particle);
    }
    for (const output of rig.outputs.slice(setting.baseOutputIndex)) {
      if (output.vertexIndex < 1 || output.vertexIndex >= setting.particleCount) {
        throw new CubismManifestError(`${path}.Output VertexIndex must identify a non-root particle`);
      }
    }
    inputIndex += setting.inputCount;
    outputIndex += setting.outputCount;
    particleIndex += setting.particleCount;
    rig.settings.push(setting);
  }

  const declared = [
    ["PhysicsSettingCount", rig.subRigCount],
    ["TotalInputCount", inputIndex],
    ["TotalOutputCount", outputIndex],
    ["VertexCount", particleIndex],
  ] as const;
  for (const [name, actual] of declared) {
    if (meta[name] !== undefined && integer(meta[name], `physics3.Meta.${name}`) !== actual) {
      throw new CubismManifestError(`physics3.Meta.${name} does not match PhysicsSettings`);
    }
  }
  return rig;
}

function normalization(value: unknown, key: "Position" | "Angle", path: string): CubismPhysicsNormalization {
  const parent = object(value, "physics3 setting Normalization");
  const normalized = object(parent[key], path);
  return Object.assign(new CubismPhysicsNormalization(), {
    minimum: finite(normalized.Minimum, `${path}.Minimum`),
    maximum: finite(normalized.Maximum, `${path}.Maximum`),
    defalut: finite(normalized.Default, `${path}.Default`),
  });
}

function physicsSource(value: unknown, path: string): CubismPhysicsSource {
  if (value === PhysicsTypeTagX) return CubismPhysicsSource.CubismPhysicsSource_X;
  if (value === PhysicsTypeTagY) return CubismPhysicsSource.CubismPhysicsSource_Y;
  if (value === PhysicsTypeTagAngle) return CubismPhysicsSource.CubismPhysicsSource_Angle;
  throw new CubismManifestError(`${path} must be X, Y or Angle`);
}

function vector(value: unknown, path: string): { x: number; y: number } {
  const source = object(value, path);
  return { x: finite(source.X, `${path}.X`), y: finite(source.Y, `${path}.Y`) };
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new CubismManifestError(`${path} must be an array`);
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CubismManifestError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CubismManifestError(`${path} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CubismManifestError(`${path} must be a boolean`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CubismManifestError(`${path} must be finite`);
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const number = finite(value, path);
  if (number < 0) throw new CubismManifestError(`${path} must be non-negative`);
  return number;
}

function integer(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!Number.isInteger(number) || number < 0) throw new CubismManifestError(`${path} must be a non-negative integer`);
  return number;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch (error) { throw new CubismManifestError(`physics3 is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
