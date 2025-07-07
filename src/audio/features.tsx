type FeaturesConstructor<F extends Features<unknown>> = new (
  sr: number,
  winLen: number,
  audioSamples?: number[],
  hopLen?: number
) => F;

abstract class Features<T> {
    sr: number;
    winLen: number;
    featuregram: T[];
    count: number;
    
    constructor(sr: number, winLen: number, audioSamples?: number[], hopLen?: number) {
        this.sr = sr;
        this.winLen = winLen;
        this.featuregram = [];
        this.count = 0;

        if (!audioSamples) return;
        if (!hopLen) hopLen = winLen;

        let numFeatures = Math.floor((audioSamples.length - winLen) / hopLen) + 1;
        if (numFeatures < 0) numFeatures = 0;        

        for (let m = 0; m < numFeatures; m++) {
            const position = m * hopLen ;
            const window = audioSamples.slice(position, position + winLen);
            this.insert(window);
        }
    }
    abstract compareFeatures(vec1: T, vec2: T): number;

    abstract makeFeature(audioFrame: number[]): T;

    abstract cloneEmpty(): this;

    compare(other: Features<T>, idxSelf: number, idxOther: number): number {
        const vecSelf = this.featuregram[idxSelf];
        const vecOther = other.featuregram[idxOther];
        return this.compareFeatures(vecSelf, vecOther);
    }

    insert(audioFrame: number[]): T {
        // console.log("<- Inserting from", audioFrame)
        const feature = this.makeFeature(audioFrame);
        this.featuregram.push(feature);
        this.count++;
        return feature;
    }   
}

export { FeaturesConstructor, Features }