import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
} from 'react';
import { cn } from '../utils';

export const Avatar = forwardRef<
  ElementRef<'div'>,
  ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'relative flex size-8 shrink-0 overflow-hidden rounded-full',
      className
    )}
    {...props}
  />
));
Avatar.displayName = 'Avatar';

export const AvatarImage = forwardRef<
  ElementRef<'img'>,
  ComponentPropsWithoutRef<'img'>
>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/useAltText: alt is passed via props
  <img
    ref={ref}
    className={cn('aspect-square h-full w-full', className)}
    {...props}
  />
));
AvatarImage.displayName = 'AvatarImage';

export const AvatarFallback = forwardRef<
  ElementRef<'div'>,
  ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground',
      className
    )}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';
