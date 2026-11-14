// Whether this process answers once and ends (`box route`, a client's request to a machine over
// SSH, whose answer is read when the process exits): what would outlive the answer goes in a
// process of its own instead.

let answersOnce = false;

/** This process answers once. */
export function answerOnce(): void {
  answersOnce = true;
}

export const answeringOnce = (): boolean => answersOnce;
